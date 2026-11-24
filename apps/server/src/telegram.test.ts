import { beforeEach, test, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUpdate, getMe, startPoller } from "./telegram.js";
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
    sender_name: "Ani Putri",
    text: "hello from the group",
    created_at: new Date(1795524000 * 1000).toISOString(),
  });
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

test("getMe returns the QuickReply bot (live, read-only)", async () => {
  const me = await getMe();
  expect(me.ok).toBe(true);
  expect(me.result.username).toBe("quickreply_g2_bot");
  expect(me.result.is_bot).toBe(true);
}, 30000);

// --- Task 8: poller allowlist gate + no remote control ---

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
