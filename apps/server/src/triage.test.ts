// Ranking for the inbox: VIP senders first, then unread, then newest.
// Pure function over stored messages — no I/O, so it is tested here and
// shared by listInbox (the store) instead of living in SQL.
import { test, expect } from "vitest";
import { rankInbox } from "./triage.js";
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
  expect(rankInbox([normalUnread, vipRead], [555]).map((m) => m.id)).toEqual([
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
  expect(rankInbox([newRead, oldUnread, newUnread], []).map((m) => m.id)).toEqual([
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
  expect(rankInbox([noId, normal], [555]).map((m) => m.id)).toEqual(["b", "a"]);
});
