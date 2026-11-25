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
  setVip,
  listVips,
  getKeywords,
  setKeywords,
  getQuietHours,
  setQuietHours,
  getOffset,
  setOffset,
  recordKnownChat,
  isAllowedChat,
  setChatAllowed,
  listKnownChats,
  seedAllowedFromMessages,
  setBusinessConnection,
  getBusinessConnection,
  listBusinessConnections,
  setChatReplies,
  getRepliesForChat,
  clearChatReplies,
  hasChatReplies,
  listChatReplies,
  isKnownChat,
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
  business_connection_id: null,
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

test("getKeywords returns the seeded defaults when nothing is stored", () => {
  expect(getKeywords()).toEqual(["urgent", "asap", "down", "failed"]);
});

test("setKeywords stores a comma list, trims, and drops empties", () => {
  expect(setKeywords("  down , FAILED,, asap ")).toBe(true);
  expect(getKeywords()).toEqual(["down", "FAILED", "asap"]);
});

test("setKeywords rejects more than 20 keywords or one over 32 chars", () => {
  expect(setKeywords(Array.from({ length: 21 }, (_, i) => `k${i}`).join(","))).toBe(
    false,
  );
  expect(setKeywords("a".repeat(33))).toBe(false);
  expect(getKeywords()).toEqual(["urgent", "asap", "down", "failed"]);
});

test("setKeywords with an empty string disables urgency matching", () => {
  expect(setKeywords("   ")).toBe(true);
  expect(getKeywords()).toEqual([]);
});

test("getQuietHours is null by default", () => {
  expect(getQuietHours()).toBeNull();
});

test("setQuietHours round-trips an overnight window", () => {
  expect(setQuietHours("22:00", "07:00")).toBe(true);
  expect(getQuietHours()).toEqual({ start: "22:00", end: "07:00" });
});

test("setQuietHours with both null disables quiet hours", () => {
  setQuietHours("22:00", "07:00");
  expect(setQuietHours(null, null)).toBe(true);
  expect(getQuietHours()).toBeNull();
});

test("setQuietHours rejects bad times and half-set windows", () => {
  expect(setQuietHours("25:00", "07:00")).toBe(false);
  expect(setQuietHours("22:60", "07:00")).toBe(false);
  expect(setQuietHours("9:00", "07:00")).toBe(false);
  expect(setQuietHours("22:00", null)).toBe(false);
  expect(setQuietHours(null, "07:00")).toBe(false);
  expect(getQuietHours()).toBeNull();
});

test("setVip on an unknown sender returns false and changes nothing", () => {
  expect(setVip(999, true)).toBe(false);
  expect(listVips()).toEqual([]);
});

test("setVip round-trips through listVips", () => {
  saveMessage(FIXTURE);
  expect(setVip(555, true)).toBe(true);
  expect(listVips()).toEqual([555]);
  expect(setVip(555, false)).toBe(true);
  expect(listVips()).toEqual([]);
});

test("listInbox puts a VIP message first even when it is already read", () => {
  saveMessage(FIXTURE);
  saveMessage({
    ...FIXTURE,
    id: "-123:8",
    update_id: 1002,
    sender_id: 777,
    sender_name: "Budi",
    text: "newer",
    created_at: new Date(1795527600 * 1000).toISOString(),
  });
  setVip(555, true);
  markRead("-123:7");
  expect(listInbox().map((m) => m.id)).toEqual(["-123:7", "-123:8"]);
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

test("business connections round-trip, and an upsert updates can_reply/is_enabled", () => {
  expect(listBusinessConnections()).toEqual([]);
  expect(getBusinessConnection("conn-1")).toBeNull();
  setBusinessConnection({
    id: "conn-1",
    user_chat_id: 777,
    can_reply: true,
    is_enabled: true,
  });
  expect(getBusinessConnection("conn-1")).toEqual({
    id: "conn-1",
    user_chat_id: 777,
    can_reply: true,
    is_enabled: true,
  });
  expect(listBusinessConnections()).toHaveLength(1);
  // Owner disconnects the bot: the same id upserts to disabled.
  setBusinessConnection({
    id: "conn-1",
    user_chat_id: 777,
    can_reply: false,
    is_enabled: false,
  });
  expect(getBusinessConnection("conn-1")).toEqual({
    id: "conn-1",
    user_chat_id: 777,
    can_reply: false,
    is_enabled: false,
  });
  expect(listBusinessConnections()).toHaveLength(1);
});

test("a message with a business connection id round-trips through save/get", () => {
  const business = {
    ...FIXTURE,
    id: "777:3",
    update_id: 1002,
    chat_id: 777,
    chat_title: "Customer",
    business_connection_id: "conn-1",
  };
  expect(saveMessage(business)).toBe(true);
  expect(getMessage("777:3")?.business_connection_id).toBe("conn-1");
  // And a normal message still reads back null.
  saveMessage(FIXTURE);
  expect(getMessage("-123:7")?.business_connection_id).toBeNull();
});

test("per-chat replies round-trip, and other chats fall back to global", () => {
  recordKnownChat(-123, "Ops");
  const work = ["On it", "In a meeting", "Will check", "Yes", "No"];
  expect(setChatReplies(-123, work)).toBe(true);
  expect(getRepliesForChat(-123)).toEqual(work);
  expect(hasChatReplies(-123)).toBe(true);
  // Another chat, and the global list, are untouched.
  expect(getRepliesForChat(-999)).toEqual(getReplies());
  expect(hasChatReplies(-999)).toBe(false);
  expect(getReplies()).toEqual([
    "On my way",
    "Noted, will check",
    "Can't talk now",
    "Yes",
    "No",
  ]);
});

test("setChatReplies rejects invalid lists and stores nothing", () => {
  recordKnownChat(-123, "Ops");
  const work = ["On it", "In a meeting", "Will check", "Yes", "No"];
  setChatReplies(-123, work);
  expect(setChatReplies(-123, ["a", "b", "c", "d"])).toBe(false);
  expect(setChatReplies(-123, ["", "b", "c", "d", "e"])).toBe(false);
  expect(setChatReplies(-123, ["a".repeat(65), "b", "c", "d", "e"])).toBe(
    false,
  );
  expect(getRepliesForChat(-123)).toEqual(work);
});

test("setChatReplies for an unknown chat returns false", () => {
  expect(isKnownChat(-123)).toBe(false);
  expect(setChatReplies(-123, ["a", "b", "c", "d", "e"])).toBe(false);
  expect(hasChatReplies(-123)).toBe(false);
});

test("clearChatReplies restores the global set with no rows left", () => {
  recordKnownChat(-123, "Ops");
  setChatReplies(-123, ["On it", "In a meeting", "Will check", "Yes", "No"]);
  expect(clearChatReplies(-123)).toBe(true);
  expect(getRepliesForChat(-123)).toEqual(getReplies());
  expect(hasChatReplies(-123)).toBe(false);
  expect(listChatReplies()).toEqual([]);
  // Clearing again is a no-op, not an error.
  expect(clearChatReplies(-123)).toBe(true);
});

test("listChatReplies returns only chats with a full custom set", () => {
  recordKnownChat(-123, "Ops");
  recordKnownChat(-456, "Family");
  const work = ["On it", "In a meeting", "Will check", "Yes", "No"];
  setChatReplies(-123, work);
  expect(listChatReplies()).toEqual([{ chat_id: -123, replies: work }]);
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
