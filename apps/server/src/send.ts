// Shared send path (Tasks 4–5): the deterministic pre-send gate
// (DEEP-DIVE §5) + idempotency (G4). The gate runs server-side; the
// client mirrors it. A send is recorded under its idempotency key BEFORE
// the receipt is returned, so a re-send with the same key returns the
// stored receipt and never calls Telegram twice. A failed Telegram call
// stores nothing, so a retry with the same key tries again.
//
// sendCanned resolves a reply slot to its text; sendText sends free text
// (the voice path). Both share this gate — never duplicate it.
import {
  getBusinessConnection,
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

// In-flight sends by idempotency key: two concurrent sends
// with the same key share one Telegram call instead of both passing the
// getSend check and sending twice. The entry is cleared on completion.
const pendingSends = new Map<string, Promise<SendResult>>();

export async function sendText(
  input: { messageId: string; text: string; idempotencyKey: string },
  sendTelegram: SendTelegramFn = sendMessage,
): Promise<SendResult> {
  const { messageId, text, idempotencyKey } = input;
  const pending = pendingSends.get(idempotencyKey);
  if (pending) return pending;
  const run = sendTextOnce(input, sendTelegram);
  pendingSends.set(idempotencyKey, run);
  try {
    return await run;
  } finally {
    pendingSends.delete(idempotencyKey);
  }
}

async function sendTextOnce(
  input: { messageId: string; text: string; idempotencyKey: string },
  sendTelegram: SendTelegramFn = sendMessage,
): Promise<SendResult> {
  const { messageId, text, idempotencyKey } = input;

  // G4 (first): a duplicate key returns the stored receipt, no Telegram call.
  const stored = getSend(idempotencyKey);
  if (stored) {
    return { ok: true, receipt: JSON.parse(stored.result_json) as Receipt };
  }

  // G3: the message must be one the bot has seen (a known chat).
  const message = getMessage(messageId);
  if (!message) return { ok: false, code: "unknown-chat" };

  // G1: non-empty after trim. G2: length ≤4096 (canned replies are ≤64 by
  // construction, but the gate is enforced here, not assumed).
  if (text.trim().length === 0) return { ok: false, code: "empty" };
  if (text.length > 4096) return { ok: false, code: "too-long" };

  // Business: a reply to a business message goes out as the business
  // account. The connection must be live (enabled + can_reply) right
  // now; otherwise fail cleanly — nothing is sent and no key is
  // consumed, so a retry after reconnecting works.
  let businessConnectionId: string | undefined;
  if (message.business_connection_id) {
    const conn = getBusinessConnection(message.business_connection_id);
    if (!conn || !conn.is_enabled || !conn.can_reply) {
      return { ok: false, code: "business-unavailable" };
    }
    businessConnectionId = conn.id;
  }

  let sent;
  try {
    sent = await sendTelegram(message.chat_id, text, businessConnectionId);
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
  // Re-read: if a concurrent same-key send recorded first, recordSend
  // was a no-op and the stored receipt is the one to return.
  const after = getSend(idempotencyKey);
  const finalReceipt = after
    ? (JSON.parse(after.result_json) as Receipt)
    : receipt;
  console.log(
    `[QuickReply] sent "${text}" to ${message.chat_title} (telegram message_id ${sent.message_id})`,
  );
  return { ok: true, receipt: finalReceipt };
}

export async function sendCanned(
  input: { messageId: string; slot: number; idempotencyKey: string },
  sendTelegram: SendTelegramFn = sendMessage,
): Promise<SendResult> {
  const { messageId, slot, idempotencyKey } = input;

  // The slot resolves to the reply text; an out-of-range slot is a client
  // bug and fails like any other send failure (the glasses show retry).
  const replies = getReplies();
  if (slot < 0 || slot >= replies.length) {
    return { ok: false, code: "send-failed" };
  }
  return sendText(
    { messageId, text: replies[slot], idempotencyKey },
    sendTelegram,
  );
}
