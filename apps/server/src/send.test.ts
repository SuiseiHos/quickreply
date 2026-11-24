import { beforeEach, test, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendCanned, sendText } from "./send.js";
import {
  saveMessage,
  getSend,
  __clearAllForTests,
  type IncomingMessage,
} from "./message-store.js";
import type { SendTelegramFn } from "./telegram.js";

process.env.QUICKREPLY_DB_PATH = join(
  tmpdir(),
  `quickreply-send-test-${process.pid}.db`,
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
  saveMessage(FIXTURE);
});

function makeFake(): {
  fn: SendTelegramFn;
  calls: { chatId: number; text: string }[];
} {
  const calls: { chatId: number; text: string }[] = [];
  const fn: SendTelegramFn = async (chatId, text) => {
    calls.push({ chatId, text });
    return { message_id: 99, chat: { id: chatId }, date: 1795524000, text };
  };
  return { fn, calls };
}

test("sends the canned text for the slot and returns a receipt", async () => {
  const { fn, calls } = makeFake();
  const result = await sendCanned(
    { messageId: "-123:7", slot: 0, idempotencyKey: "key-1" },
    fn,
  );
  expect(calls).toEqual([{ chatId: -123, text: "On my way" }]);
  expect(result).toEqual({
    ok: true,
    receipt: {
      messageId: "-123:7",
      chatTitle: "Ops",
      text: "On my way",
      sentAt: new Date(1795524000 * 1000).toISOString(),
    },
  });
  expect(getSend("key-1")?.message_id).toBe(99);
});

test("same idempotency key re-send returns the stored receipt, no second call", async () => {
  const { fn, calls } = makeFake();
  const first = await sendCanned(
    { messageId: "-123:7", slot: 0, idempotencyKey: "key-2" },
    fn,
  );
  const second = await sendCanned(
    { messageId: "-123:7", slot: 0, idempotencyKey: "key-2" },
    fn,
  );
  expect(calls).toHaveLength(1);
  expect(second).toEqual(first);
});

test("unknown message id returns unknown-chat and does not call Telegram", async () => {
  const { fn, calls } = makeFake();
  const result = await sendCanned(
    { messageId: "-123:999", slot: 0, idempotencyKey: "key-3" },
    fn,
  );
  expect(result).toEqual({ ok: false, code: "unknown-chat" });
  expect(calls).toHaveLength(0);
});

test("invalid slot returns send-failed without calling Telegram", async () => {
  const { fn, calls } = makeFake();
  const result = await sendCanned(
    { messageId: "-123:7", slot: 9, idempotencyKey: "key-4" },
    fn,
  );
  expect(result).toEqual({ ok: false, code: "send-failed" });
  expect(calls).toHaveLength(0);
});

test("a failed Telegram send returns send-failed and stores no key", async () => {
  const failing: SendTelegramFn = async () => {
    throw new Error("Telegram 500");
  };
  const first = await sendCanned(
    { messageId: "-123:7", slot: 0, idempotencyKey: "key-5" },
    failing,
  );
  expect(first).toEqual({ ok: false, code: "send-failed" });
  expect(getSend("key-5")).toBeNull();
  // A retry with the same key calls Telegram again (nothing was stored).
  const { fn, calls } = makeFake();
  const second = await sendCanned(
    { messageId: "-123:7", slot: 0, idempotencyKey: "key-5" },
    fn,
  );
  expect(second.ok).toBe(true);
  expect(calls).toHaveLength(1);
});

// --- sendText (Task 5): the voice path resolves the text itself and
// shares the same gate + idempotency as the canned path. ---

test("sendText sends free text and returns a receipt", async () => {
  const { fn, calls } = makeFake();
  const result = await sendText(
    { messageId: "-123:7", text: "Running late, sorry!", idempotencyKey: "vt-1" },
    fn,
  );
  expect(calls).toEqual([{ chatId: -123, text: "Running late, sorry!" }]);
  expect(result).toEqual({
    ok: true,
    receipt: {
      messageId: "-123:7",
      chatTitle: "Ops",
      text: "Running late, sorry!",
      sentAt: new Date(1795524000 * 1000).toISOString(),
    },
  });
});

test("sendText rejects empty text without calling Telegram", async () => {
  const { fn, calls } = makeFake();
  const result = await sendText(
    { messageId: "-123:7", text: "   ", idempotencyKey: "vt-2" },
    fn,
  );
  expect(result).toEqual({ ok: false, code: "empty" });
  expect(calls).toHaveLength(0);
});

test("sendText rejects over-long text without calling Telegram", async () => {
  const { fn, calls } = makeFake();
  const result = await sendText(
    { messageId: "-123:7", text: "x".repeat(4097), idempotencyKey: "vt-3" },
    fn,
  );
  expect(result).toEqual({ ok: false, code: "too-long" });
  expect(calls).toHaveLength(0);
});

test("sendText for an unknown message returns unknown-chat", async () => {
  const { fn, calls } = makeFake();
  const result = await sendText(
    { messageId: "-123:999", text: "hello", idempotencyKey: "vt-4" },
    fn,
  );
  expect(result).toEqual({ ok: false, code: "unknown-chat" });
  expect(calls).toHaveLength(0);
});

test("sendText re-send with the same key returns the stored receipt", async () => {
  const { fn, calls } = makeFake();
  const first = await sendText(
    { messageId: "-123:7", text: "See you soon.", idempotencyKey: "vt-5" },
    fn,
  );
  const second = await sendText(
    { messageId: "-123:7", text: "See you soon.", idempotencyKey: "vt-5" },
    fn,
  );
  expect(calls).toHaveLength(1);
  expect(second).toEqual(first);
});

// Review F2: two CONCURRENT sends with the same key share one Telegram
// call and return identical receipts (no double-send, no spurious error).
test("concurrent sends with the same key share one Telegram call", async () => {
  const { fn, calls } = makeFake();
  const [first, second] = await Promise.all([
    sendText(
      { messageId: "-123:7", text: "Racing.", idempotencyKey: "race-1" },
      fn,
    ),
    sendText(
      { messageId: "-123:7", text: "Racing.", idempotencyKey: "race-1" },
      fn,
    ),
  ]);
  expect(calls).toHaveLength(1);
  expect(second).toEqual(first);
  expect(getSend("race-1")).not.toBeNull();
});
