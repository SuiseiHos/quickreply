import { beforeEach, test, expect } from "vitest";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUpdate, parseChatMemberUpdate, getMe, startPoller } from "./telegram.js";
import {
  recordKnownChat,
  isAllowedChat,
  setChatAllowed,
  listInbox,
  getOffset,
  __clearAllForTests,
} from "./message-store.js";

process.env.QUICKREPLY_DB_PATH = join(
  tmpdir(),
  `quickreply-telegram-test-${process.pid}.db`,
);

beforeEach(() => {
  __clearAllForTests();
});

const GROUP_UPDATE = {
  update_id: 1001,
  message: {
    message_id: 7,
    date: 1795524000,
    chat: { id: -123, title: "Ops", type: "group" },
    from: { id: 555, first_name: "Ani", last_name: "Putri" },
    text: "hello from the group",
  },
};

test("parseUpdate converts a group text message", () => {
  expect(parseUpdate(GROUP_UPDATE)).toEqual({
    id: "-123:7",
    update_id: 1001,
    chat_id: -123,
    chat_title: "Ops",
    sender_id: 555,
    sender_name: "Ani Putri",
    text: "hello from the group",
    created_at: new Date(1795524000 * 1000).toISOString(),
  });
});

test("parseUpdate sets sender_id null when the sender has no id", () => {
  const update = {
    update_id: 1004,
    message: {
      message_id: 9,
      date: 1795524000,
      chat: { id: -123, title: "Ops", type: "group" },
      from: { first_name: "NoId" },
      text: "hello",
    },
  };
  expect(parseUpdate(update)?.sender_id).toBeNull();
});

test("parseUpdate uses the sender name as chat title for a private chat", () => {
  const update = {
    update_id: 1002,
    message: {
      message_id: 3,
      date: 1795524000,
      chat: { id: 777, type: "private" },
      from: { id: 777, first_name: "Budi" },
      text: "hi",
    },
  };
  const parsed = parseUpdate(update);
  expect(parsed?.chat_title).toBe("Budi");
  expect(parsed?.id).toBe("777:3");
});

test("parseUpdate ignores updates without a text message", () => {
  expect(parseUpdate({ update_id: 1003 })).toBeNull();
  expect(
    parseUpdate({
      update_id: 1004,
      edited_message: { ...GROUP_UPDATE.message, text: "edited" },
    }),
  ).toBeNull();
  expect(
    parseUpdate({
      update_id: 1005,
      message: { ...GROUP_UPDATE.message, text: undefined, photo: [{}] },
    }),
  ).toBeNull();
});

test("parseUpdate ignores messages from other bots", () => {
  const update = {
    update_id: 1006,
    message: {
      ...GROUP_UPDATE.message,
      from: { id: 999, first_name: "OtherBot", is_bot: true },
    },
  };
  expect(parseUpdate(update)).toBeNull();
});

// Live, read-only — and skipped when the helper is absent,
// so `npm test` stays portable on a fresh checkout without the vaulted
// Telegram connection.
const HELPER_PATH =
  process.env.TELEGRAM_HELPER_PATH ??
  "/home/hatch/workspace/custom-connectors/custom.telegram/bin/telegram.py";
test.skipIf(!existsSync(HELPER_PATH))(
  "getMe returns the QuickReply bot (live, read-only)",
  async () => {
    const me = await getMe();
    expect(me.ok).toBe(true);
    expect(me.result.username).toBe("quickreply_g2_bot");
    expect(me.result.is_bot).toBe(true);
  },
  30000,
);

// --- poller allowlist gate + no remote control ---

function groupUpdate(updateId: number, chatId: number, title: string, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1795524000,
      chat: { id: chatId, title, type: "group" },
      from: { id: 555, first_name: "Ani" },
      text,
    },
  };
}

async function runPollerOnce(batches: unknown[][]) {
  const forwarded: unknown[] = [];
  const newChats: { chat_id: number; chat_title: string }[] = [];
  let calls = 0;
  const poller = startPoller({
    onMessage: (m) => forwarded.push(m),
    onNewChat: (c) => newChats.push(c),
    fetchUpdates: async () => {
      // Each batch is delivered once, like Telegram (the offset advances);
      // later rounds return [].
      const batch = calls < batches.length ? batches[calls] : [];
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return batch;
    },
  });
  await new Promise((r) => setTimeout(r, 120));
  poller.stop();
  // Let an in-flight round settle before the caller reads state: stop()
  // does not wait for it, and a late batch must be judged under the
  // allowlist as it stood when the round was fetched.
  await new Promise((r) => setTimeout(r, 30));
  return { forwarded, newChats };
}

test("poller forwards only allowlisted chats; a stranger's /command changes nothing", async () => {
  recordKnownChat(-123, "Ops");
  setChatAllowed(-123, true);
  const { forwarded, newChats } = await runPollerOnce([
    [
      groupUpdate(2001, -123, "Ops", "hello from Ops"),
      groupUpdate(2002, -999, "Stranger", "/allow -999"),
      groupUpdate(2003, -999, "Stranger", "let me in"),
    ],
  ]);
  expect(forwarded).toHaveLength(1);
  expect((forwarded[0] as { chat_id: number }).chat_id).toBe(-123);
  expect(listInbox()).toHaveLength(1);
  // The stranger's chat is recorded as pending, but NOT allowed — the
  // "/allow" text was never executed.
  expect(newChats).toEqual([{ chat_id: -999, chat_title: "Stranger" }]);
  expect(isAllowedChat(-999)).toBe(false);
  // The offset still advances past dropped updates (no re-fetch loop).
  expect(getOffset()).toBe(2004);
});

test("poller forwards a chat once it becomes allowed", async () => {
  const { forwarded } = await runPollerOnce([
    [groupUpdate(2011, -999, "Stranger", "first, blocked")],
    [groupUpdate(2012, -999, "Stranger", "second, allowed")],
  ]);
  // The first batch is dropped; allow the chat mid-run, then the second
  // batch's message flows. (The allow happens between the two batches
  // because the fake fetch yields after each batch.)
  expect(forwarded).toHaveLength(0);
  expect(listInbox()).toHaveLength(0);
  setChatAllowed(-999, true);
  const second = await runPollerOnce([
    [groupUpdate(2013, -999, "Stranger", "third, allowed")],
  ]);
  expect(second.forwarded).toHaveLength(1);
  expect(listInbox()).toHaveLength(1);
});

// --- bot removal from a chat ---

test("parseChatMemberUpdate reports kicked/left, ignores the rest", () => {
  const kicked = {
    update_id: 3001,
    my_chat_member: {
      chat: { id: -123, title: "Ops", type: "group" },
      new_chat_member: { status: "kicked" },
    },
  };
  expect(parseChatMemberUpdate(kicked)).toEqual({
    chat_id: -123,
    chat_title: "Ops",
    status: "kicked",
  });
  const left = {
    update_id: 3002,
    my_chat_member: {
      chat: { id: -123, title: "Ops", type: "group" },
      new_chat_member: { status: "left" },
    },
  };
  expect(parseChatMemberUpdate(left)?.status).toBe("left");
  const member = {
    update_id: 3003,
    my_chat_member: {
      chat: { id: -123, title: "Ops", type: "group" },
      new_chat_member: { status: "member" },
    },
  };
  expect(parseChatMemberUpdate(member)).toBeNull();
  expect(parseChatMemberUpdate(GROUP_UPDATE)).toBeNull();
});

test("poller removes an allowed chat when the bot is kicked", async () => {  recordKnownChat(-123, "Ops");
  setChatAllowed(-123, true);
  const removed: { chat_id: number; chat_title: string }[] = [];
  let calls = 0;
  const poller = startPoller({
    onMessage: () => {},
    onChatRemoved: (c) => removed.push(c),
    fetchUpdates: async () => {
      // The update is delivered once, like Telegram (the offset advances).
      const batch =
        calls === 0
          ? [
              {
                update_id: 3011,
                my_chat_member: {
                  chat: { id: -123, title: "Ops", type: "group" },
                  new_chat_member: { status: "kicked" },
                },
              },
            ]
          : [];
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return batch;
    },
  });
  await new Promise((r) => setTimeout(r, 120));
  poller.stop();
  await new Promise((r) => setTimeout(r, 30));
  expect(isAllowedChat(-123)).toBe(false);
  expect(removed).toEqual([{ chat_id: -123, chat_title: "Ops" }]);
  expect(listInbox()).toHaveLength(0);
});

// The offset is committed PER UPDATE, so a throw — or a restart —
// mid-batch cannot leave an already-processed update unacknowledged.
// Telegram would then re-deliver it, and a message dropped while its
// chat was pending could be stored after the chat was approved.
test("offset commits per update when a later update in the batch throws", async () => {
  recordKnownChat(-123, "Ops");
  setChatAllowed(-123, true);
  const first = groupUpdate(4001, -123, "Ops", "first");
  const second = groupUpdate(4002, -123, "Ops", "second");
  let calls = 0;
  const poller = startPoller({
    onMessage: (m) => {
      if (m.text === "second") throw new Error("broadcast blew up");
    },
    fetchUpdates: async () => {
      const batch = calls === 0 ? [first, second] : [];
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return batch;
    },
  });
  await new Promise((r) => setTimeout(r, 150));
  poller.stop();
  await new Promise((r) => setTimeout(r, 30));
  // The first update was processed AND its offset committed before the
  // second one threw, so it is never re-fetched. The second update's
  // offset was NOT committed (its broadcast threw after the store), so it
  // would be re-fetched next round — and saveMessage dedupes it by
  // update_id, so it still lands exactly once.
  expect(getOffset()).toBe(4002);
  expect(listInbox()).toHaveLength(2);
  expect(listInbox().map((m) => m.text).sort()).toEqual(["first", "second"]);
});
