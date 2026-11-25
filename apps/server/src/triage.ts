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
