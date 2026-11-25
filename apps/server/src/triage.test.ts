// Ranking for the inbox: VIP senders first, then unread, then newest.
// Pure function over stored messages — no I/O, so it is tested here and
// shared by listInbox (the store) instead of living in SQL.
import { test, expect } from "vitest";
import { rankInbox, isUrgent } from "./triage.js";
import type { StoredMessage } from "./message-store.js";

function msg(over: Partial<StoredMessage> & { id: string }): StoredMessage {
  return {
    update_id: 1,
    chat_id: -123,
    chat_title: "Ops",
    sender_id: null,
    sender_name: "A",
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
