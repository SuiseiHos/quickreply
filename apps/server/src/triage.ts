// Inbox ranking: VIP senders first, then urgent, then unread, then newest.
// Pure function over stored messages — no I/O. listInbox (the store)
// calls it; the urgency tier reads the keyword list, never the store.
import type { StoredMessage } from "./message-store.js";

/**
 * Case-insensitive substring match. "down" matching "shutdown" is
 * accepted and documented — a false positive beats a missed page.
 */
export function isUrgent(text: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const lower = text.toLowerCase();
  return keywords.some(
    (k) => k.length > 0 && lower.includes(k.toLowerCase()),
  );
}

export type QuietHours = { start: string; end: string } | null;

/** HH:MM on the 24-hour clock. Start is inclusive, end is exclusive.
 * An overnight window (end < start) crosses midnight. Null bounds mean
 * quiet hours are off. `now` is read in server-local time (WIB). */
export function isQuietHour(
  now: Date,
  start: string | null,
  end: string | null,
): boolean {
  if (start === null || end === null) return false;
  const toMinutes = (hhmm: string): number => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };
  const at = now.getHours() * 60 + now.getMinutes();
  const from = toMinutes(start);
  const to = toMinutes(end);
  if (from === to) return false;
  if (from < to) return at >= from && at < to;
  return at >= from || at < to;
}

/**
 * The poller push gate: a message is stored always, but pushed to the
 * glasses only when it is not quiet hours — or when it is VIP or urgent.
 */
export function shouldPush(
  message: Pick<StoredMessage, "sender_id" | "text">,
  vips: number[],
  keywords: string[],
  quietHours: QuietHours,
  now: Date,
): boolean {
  if (!quietHours) return true;
  if (!isQuietHour(now, quietHours.start, quietHours.end)) return true;
  if (message.sender_id !== null && vips.includes(message.sender_id)) return true;
  return isUrgent(message.text, keywords);
}

export function rankInbox(
  messages: StoredMessage[],
  vips: number[],
  keywords: string[],
): StoredMessage[] {
  const vipSet = new Set(vips);
  const isVip = (m: StoredMessage): boolean =>
    m.sender_id !== null && vipSet.has(m.sender_id);
  return [...messages].sort((a, b) => {
    const av = isVip(a) ? 0 : 1;
    const bv = isVip(b) ? 0 : 1;
    if (av !== bv) return av - bv;
    const au = isUrgent(a.text, keywords) ? 0 : 1;
    const bu = isUrgent(b.text, keywords) ? 0 : 1;
    if (au !== bu) return au - bu;
    if (a.read !== b.read) return a.read - b.read;
    if (a.created_at !== b.created_at)
      return a.created_at < b.created_at ? 1 : -1;
    return b.update_id - a.update_id;
  });
}
