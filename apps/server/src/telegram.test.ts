import { test, expect } from "vitest";
import { parseUpdate, getMe } from "./telegram.js";

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
