// Ranking for the inbox: VIP senders first, then unread, then newest.
// Pure function over stored messages — no I/O, so it is tested here and
// shared by listInbox (the store) instead of living in SQL.
import { test, expect } from "vitest";
import { rankInbox, isUrgent, isQuietHour, shouldPush } from "./triage.js";
import type { StoredMessage } from "./message-store.js";

function msg(over: Partial<StoredMessage> & { id: string }): StoredMessage {
  return {
    update_id: 1,
    chat_id: -123,
    chat_title: "Ops",
    sender_id: null,
    sender_name: "A",
    business_connection_id: null,
    text: "hi",
    created_at: "2026-11-25T00:00:00.000Z",
    read: 0,
    ...over,
  };
}

test("rankInbox puts a VIP message first regardless of read state", () => {
  const vipRead = msg({
    id: "a",
    sender_id: 555,
    read: 1,
    created_at: "2026-11-25T00:00:00.000Z",
  });
  const normalUnread = msg({
    id: "b",
    sender_id: 777,
    read: 0,
    created_at: "2026-11-25T01:00:00.000Z",
  });
  expect(rankInbox([normalUnread, vipRead], [555], []).map((m) => m.id)).toEqual([
    "a",
    "b",
  ]);
});

test("rankInbox keeps unread-first then newest for non-VIP", () => {
  const oldUnread = msg({ id: "a", read: 0 });
  const newRead = msg({
    id: "b",
    read: 1,
    created_at: "2026-11-25T01:00:00.000Z",
  });
  const newUnread = msg({
    id: "c",
    read: 0,
    created_at: "2026-11-25T02:00:00.000Z",
  });
  expect(rankInbox([newRead, oldUnread, newUnread], [], []).map((m) => m.id)).toEqual([
    "c",
    "a",
    "b",
  ]);
});

test("rankInbox does not treat a null sender id as VIP", () => {
  const noId = msg({ id: "a", sender_id: null, read: 0 });
  const normal = msg({
    id: "b",
    sender_id: 777,
    read: 0,
    created_at: "2026-11-25T02:00:00.000Z",
  });
  expect(rankInbox([noId, normal], [555], []).map((m) => m.id)).toEqual(["b", "a"]);
});

test("isUrgent matches keywords case-insensitively, as substrings", () => {
  expect(isUrgent("Server is DOWN", ["down"])).toBe(true);
  expect(isUrgent("ASAP please", ["asap"])).toBe(true);
  // Substring, not word-boundary: "down" matches "shutdown".
  // Accepted and documented — a false positive beats a missed page.
  expect(isUrgent("shutting down", ["down"])).toBe(true);
  expect(isUrgent("all good", ["down"])).toBe(false);
  expect(isUrgent("Server is down", [])).toBe(false);
  expect(isUrgent("", ["down"])).toBe(false);
});

test("rankInbox puts an urgent message ahead of a non-urgent unread one", () => {
  const urgentRead = msg({
    id: "a",
    read: 1,
    text: "server is down",
    created_at: "2026-11-25T00:00:00.000Z",
  });
  const normalUnread = msg({
    id: "b",
    read: 0,
    text: "lunch?",
    created_at: "2026-11-25T01:00:00.000Z",
  });
  expect(
    rankInbox([normalUnread, urgentRead], [], ["down"]).map((m) => m.id),
  ).toEqual(["a", "b"]);
});

test("rankInbox still puts VIP ahead of urgent", () => {
  const urgent = msg({ id: "a", text: "server is down" });
  const vip = msg({ id: "b", sender_id: 555, text: "hi" });
  expect(
    rankInbox([urgent, vip], [555], ["down"]).map((m) => m.id),
  ).toEqual(["b", "a"]);
});

function at(hour: number, minute: number): Date {
  // A WIB wall-clock instant: quiet hours are defined in Jakarta time,
  // so the instant is built from UTC explicitly instead of relying on
  // the process-local timezone (the VM runs in UTC).
  return new Date(Date.UTC(2026, 10, 25, hour - 7, minute));
}

test("isQuietHour reads Jakarta wall-clock time, not the process timezone", () => {
  // 16:00 UTC is 23:00 in Jakarta — quiet in a 22:00-07:00 window,
  // even though 16:00 UTC itself is outside it.
  expect(isQuietHour(new Date(Date.UTC(2026, 10, 25, 16, 0)), "22:00", "07:00")).toBe(true);
  // 01:00 UTC is 08:00 in Jakarta — outside the window.
  expect(isQuietHour(new Date(Date.UTC(2026, 10, 25, 1, 0)), "22:00", "07:00")).toBe(false);
});

test("isQuietHour covers an overnight window, start inclusive, end exclusive", () => {
  expect(isQuietHour(at(22, 0), "22:00", "07:00")).toBe(true);
  expect(isQuietHour(at(23, 30), "22:00", "07:00")).toBe(true);
  expect(isQuietHour(at(6, 59), "22:00", "07:00")).toBe(true);
  expect(isQuietHour(at(7, 0), "22:00", "07:00")).toBe(false);
  expect(isQuietHour(at(21, 59), "22:00", "07:00")).toBe(false);
  expect(isQuietHour(at(12, 0), "22:00", "07:00")).toBe(false);
});

test("isQuietHour covers a daytime window, boundaries on both sides", () => {
  expect(isQuietHour(at(9, 0), "09:00", "17:00")).toBe(true);
  expect(isQuietHour(at(12, 0), "09:00", "17:00")).toBe(true);
  expect(isQuietHour(at(16, 59), "09:00", "17:00")).toBe(true);
  expect(isQuietHour(at(17, 0), "09:00", "17:00")).toBe(false);
  expect(isQuietHour(at(8, 59), "09:00", "17:00")).toBe(false);
});

test("isQuietHour is off when either bound is null", () => {
  expect(isQuietHour(at(23, 0), null, "07:00")).toBe(false);
  expect(isQuietHour(at(23, 0), "22:00", null)).toBe(false);
  expect(isQuietHour(at(23, 0), null, null)).toBe(false);
});

test("shouldPush holds a normal message during quiet hours", () => {
  const m = msg({ id: "a", sender_id: 777, text: "hi" });
  expect(shouldPush(m, [], ["down"], { start: "22:00", end: "07:00" }, at(23, 0))).toBe(false);
  expect(shouldPush(m, [], ["down"], { start: "22:00", end: "07:00" }, at(12, 0))).toBe(true);
  expect(shouldPush(m, [], ["down"], null, at(23, 0))).toBe(true);
});

test("shouldPush lets VIP and urgent messages through quiet hours", () => {
  const vip = msg({ id: "a", sender_id: 555, text: "hi" });
  const urgent = msg({ id: "b", sender_id: 777, text: "server is down" });
  const q = { start: "22:00", end: "07:00" };
  expect(shouldPush(vip, [555], ["down"], q, at(23, 0))).toBe(true);
  expect(shouldPush(urgent, [], ["down"], q, at(23, 0))).toBe(true);
});
