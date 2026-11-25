// Inbox ranking: VIP senders first, then unread, then newest.
// Pure function over stored messages — no I/O. listInbox (the store)
// calls it; the urgency tier (Task 4) extends the signature with
// keywords instead of duplicating the sort.
import type { StoredMessage } from "./message-store.js";

export function rankInbox(
  messages: StoredMessage[],
  vips: number[],
): StoredMessage[] {
  const vipSet = new Set(vips);
  const isVip = (m: StoredMessage): boolean =>
    m.sender_id !== null && vipSet.has(m.sender_id);
  return [...messages].sort((a, b) => {
    const av = isVip(a) ? 0 : 1;
    const bv = isVip(b) ? 0 : 1;
    if (av !== bv) return av - bv;
    if (a.read !== b.read) return a.read - b.read;
    if (a.created_at !== b.created_at)
      return a.created_at < b.created_at ? 1 : -1;
    return b.update_id - a.update_id;
  });
}
