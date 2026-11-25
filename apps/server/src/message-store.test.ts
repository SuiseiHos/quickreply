import { beforeEach, test, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveMessage,
  getReplies,
  setReplies,
  markRead,
  getMessage,
  listChats,
  listInbox,
  listSenders,
  getOffset,
  setOffset,
  recordKnownChat,
  isAllowedChat,
  setChatAllowed,
  listKnownChats,
  seedAllowedFromMessages,
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
  sender_id: 555,
  sender_name: "Ani",
  text: "hello from the group",
  created_at: new Date(1795524000 * 1000).toISOString(),
};

beforeEach(() => {
  __clearAllForTests();
});

test("listSenders returns distinct senders by id", () => {
  saveMessage(FIXTURE);
  saveMessage({ ...FIXTURE, id: "-123:8", update_id: 1002, text: "again" });
  saveMessage({
    ...FIXTURE,
    id: "-123:9",
    update_id: 1003,
    sender_id: 777,
    sender_name: "Budi",
    text: "hi",
  });
  expect(listSenders()).toEqual([
    { sender_id: 555, sender_name: "Ani" },
    { sender_id: 777, sender_name: "Budi" },
  ]);
});

test("listSenders skips messages with no sender id", () => {
  saveMessage({ ...FIXTURE, sender_id: null });
  expect(listSenders()).toEqual([]);
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

test("getReplies seeds the 5 default canned replies", () => {
  expect(getReplies()).toEqual([
    "On my way",
    "Noted, will check",
    "Can't talk now",
    "Yes",
    "No",
  ]);
});

test("setReplies stores 5 new replies and getReplies returns them", () => {
  expect(
    setReplies(["Got it", "On it", "Later", "OK", "Nope"]),
  ).toBe(true);
  expect(getReplies()).toEqual(["Got it", "On it", "Later", "OK", "Nope"]);
});

test("setReplies rejects the wrong count or an over-long reply", () => {
  expect(setReplies(["only one"])).toBe(false);
  expect(setReplies(["a", "b", "c", "d", "x".repeat(65)])).toBe(false);
  expect(getReplies()[0]).toBe("On my way");
});

test("markRead flips a message to read", () => {
  saveMessage(FIXTURE);
  expect(listInbox()[0].read).toBe(0);
  markRead("-123:7");
  expect(listInbox()[0].read).toBe(1);
});

test("getMessage returns a stored message by id, null when unknown", () => {
  saveMessage(FIXTURE);
  expect(getMessage("-123:7")?.text).toBe("hello from the group");
  expect(getMessage("-123:999")).toBeNull();
});

test("listChats returns each chat once", () => {
  saveMessage(FIXTURE);
  saveMessage({ ...FIXTURE, id: "-456:1", update_id: 1002, chat_id: -456, chat_title: "Alerts" });
  saveMessage({ ...FIXTURE, id: "-123:8", update_id: 1003, text: "second" });
  expect(listChats()).toEqual([
    { chat_id: -456, chat_title: "Alerts" },
    { chat_id: -123, chat_title: "Ops" },
  ]);
});

// --- chat allowlist (default-deny) ---

test("an unknown chat is not allowed by default", () => {
  expect(isAllowedChat(-123)).toBe(false);
  expect(listKnownChats()).toEqual([]);
});

test("recordKnownChat reports first sighting, then repeats", () => {
  expect(recordKnownChat(-123, "Ops")).toBe(true);
  expect(recordKnownChat(-123, "Ops")).toBe(false);
  expect(recordKnownChat(-123, "Ops Renamed")).toBe(false);
  expect(listKnownChats()).toEqual([
    { chat_id: -123, chat_title: "Ops Renamed", allowed: false },
  ]);
});

test("setChatAllowed refuses an unknown chat", () => {
  expect(setChatAllowed(-123, true)).toBe(false);
  expect(isAllowedChat(-123)).toBe(false);
});

test("setChatAllowed toggles a known chat both ways", () => {
  recordKnownChat(-123, "Ops");
  expect(setChatAllowed(-123, true)).toBe(true);
  expect(isAllowedChat(-123)).toBe(true);
  expect(setChatAllowed(-123, false)).toBe(true);
  expect(isAllowedChat(-123)).toBe(false);
  expect(listKnownChats()).toEqual([
    { chat_id: -123, chat_title: "Ops", allowed: false },
  ]);
});

test("seedAllowedFromMessages grandfathers chats with stored messages", () => {
  saveMessage(FIXTURE);
  saveMessage({ ...FIXTURE, id: "-456:1", update_id: 1002, chat_id: -456, chat_title: "Alerts" });
  expect(seedAllowedFromMessages()).toBe(2);
  expect(isAllowedChat(-123)).toBe(true);
  expect(isAllowedChat(-456)).toBe(true);
  expect(isAllowedChat(-789)).toBe(false);
  // Idempotent: a second seed inserts nothing new.
  expect(seedAllowedFromMessages()).toBe(0);
  expect(listKnownChats()).toEqual([
    { chat_id: -456, chat_title: "Alerts", allowed: true },
    { chat_id: -123, chat_title: "Ops", allowed: true },
  ]);
});

// the seed is ONE-TIME. A chat the user toggled off must stay
// off even when the server restarts (and re-runs the seed).
test("seedAllowedFromMessages never re-allows a chat toggled off", () => {
  saveMessage(FIXTURE);
  expect(seedAllowedFromMessages()).toBe(1);
  expect(isAllowedChat(-123)).toBe(true);
  setChatAllowed(-123, false);
  expect(seedAllowedFromMessages()).toBe(0);
  expect(isAllowedChat(-123)).toBe(false);
});
