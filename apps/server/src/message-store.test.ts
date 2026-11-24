import { beforeEach, test, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveMessage,
  listInbox,
  getOffset,
  setOffset,
  __clearAllForTests,
  type IncomingMessage,
} from "./message-store.js";

process.env.QUICKREPLY_DB_PATH = join(
  tmpdir(),
  `quickreply-store-test-${process.pid}.db`,
);

const FIXTURE: IncomingMessage = {
  id: "-123:7",
  update_id: 1001,
  chat_id: -123,
  chat_title: "Ops",
  sender_name: "Ani",
  text: "hello from the group",
  created_at: new Date(1795524000 * 1000).toISOString(),
};

beforeEach(() => {
  __clearAllForTests();
});

test("saveMessage stores a message and listInbox returns it", () => {
  expect(saveMessage(FIXTURE)).toBe(true);
  const inbox = listInbox();
  expect(inbox).toHaveLength(1);
  expect(inbox[0]).toMatchObject({
    id: "-123:7",
    chat_id: -123,
    chat_title: "Ops",
    sender_name: "Ani",
    text: "hello from the group",
    read: 0,
  });
});

test("saveMessage dedupes by update_id: second save returns false", () => {
  expect(saveMessage(FIXTURE)).toBe(true);
  expect(saveMessage(FIXTURE)).toBe(false);
  expect(listInbox()).toHaveLength(1);
});

test("listInbox orders unread first, then newest", () => {
  const older: IncomingMessage = { ...FIXTURE, id: "-123:5", update_id: 999, text: "older" };
  const newer: IncomingMessage = { ...FIXTURE, id: "-123:9", update_id: 1003, text: "newer" };
  saveMessage(newer);
  saveMessage(older);
  saveMessage(FIXTURE);
  const inbox = listInbox();
  expect(inbox.map((m) => m.update_id)).toEqual([1003, 1001, 999]);
});

test("offset persists: setOffset then getOffset round-trips", () => {
  expect(getOffset()).toBe(0);
  setOffset(1002);
  expect(getOffset()).toBe(1002);
});
