// Canned send path (Task 4): the deterministic pre-send gate (DEEP-DIVE
// §5) + idempotency (G4). The gate runs server-side; the client mirrors it.
// A send is recorded under its idempotency key BEFORE the receipt is
// returned, so a re-send with the same key returns the stored receipt and
// never calls Telegram twice. A failed Telegram call stores nothing, so a
// retry with the same key tries again.
import {
  getMessage,
  getReplies,
  getSend,
  recordSend,
} from "./message-store.js";
import { sendMessage, type SendTelegramFn } from "./telegram.js";

export type Receipt = {
  messageId: string;
  chatTitle: string;
  text: string;
  sentAt: string;
};

export type SendResult =
  | { ok: true; receipt: Receipt }
  | { ok: false; code: string };

export async function sendCanned(
  input: { messageId: string; slot: number; idempotencyKey: string },
  sendTelegram: SendTelegramFn = sendMessage,
): Promise<SendResult> {
  const { messageId, slot, idempotencyKey } = input;

  // G4 (first): a duplicate key returns the stored receipt, no Telegram call.
  const stored = getSend(idempotencyKey);
  if (stored) {
    return { ok: true, receipt: JSON.parse(stored.result_json) as Receipt };
  }

  // G3: the message must be one the bot has seen (a known chat).
  const message = getMessage(messageId);
  if (!message) return { ok: false, code: "unknown-chat" };

  // The slot resolves to the reply text; an out-of-range slot is a client
  // bug and fails like any other send failure (the glasses show retry).
  const replies = getReplies();
  if (slot < 0 || slot >= replies.length) {
    return { ok: false, code: "send-failed" };
  }
  const text = replies[slot];

  // G1: non-empty after trim. G2: length ≤4096 (canned replies are ≤64 by
  // construction, but the gate is enforced here, not assumed).
  if (text.trim().length === 0) return { ok: false, code: "empty" };
  if (text.length > 4096) return { ok: false, code: "too-long" };

  let sent;
  try {
    sent = await sendTelegram(message.chat_id, text);
  } catch {
    return { ok: false, code: "send-failed" };
  }

  const receipt: Receipt = {
    messageId,
    chatTitle: message.chat_title,
    text,
    sentAt:
      typeof sent.date === "number"
        ? new Date(sent.date * 1000).toISOString()
        : new Date().toISOString(),
  };
  recordSend(
    idempotencyKey,
    sent.message_id,
    message.chat_id,
    text,
    JSON.stringify(receipt),
  );
  console.log(
    `[QuickReply] sent "${text}" to ${message.chat_title} (telegram message_id ${sent.message_id})`,
  );
  return { ok: true, receipt };
}
