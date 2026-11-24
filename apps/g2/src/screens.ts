// Screen text builders for the G2 glasses UI (576x288, monochrome).
// Layouts follow DEEP-DIVE.md section 4 exactly; English only (demo language).
// ASCII where it matters: the glasses font does not render "▸" (verified
// 24 Nov 2026) and "…" is untested, so truncation uses "...".

export type InboxMessage = {
  id: string;
  chat_id: number;
  chat_title: string;
  sender_name: string;
  text: string;
  created_at: string;
  read: number;
};

const LIST_LINE_MAX = 64;
const INBOX_PAGE_SIZE = 5;

/** Word-wrap text to lines of at most `width` chars, at most `maxLines`
 * lines; a cut-off last line ends with "...". */
export function wrapText(text: string, width: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = "";
  let truncated = false;
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    if (lines.length === maxLines) {
      truncated = true;
      break;
    }
    // A single word longer than the width is hard-cut.
    if (word.length > width) {
      current = word.slice(0, width);
      truncated = true;
    } else {
      current = word;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  if (truncated && lines.length > 0) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] =
      last.length > 3 ? `${last.slice(0, last.length - 3)}...` : "...";
  }
  return lines;
}

/** First line of a message (up to the first newline), for list rows. */
function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

/** Home screen (Screen 1); the count is live from the backend store.
 * When a message just arrived, the count line previews it instead. */
export function homeScreen(
  unreadCount: number,
  latest?: { chatTitle: string; firstLine: string },
): string {
  const statusLine = latest
    ? `New from ${latest.chatTitle}: ${latest.firstLine}`.slice(0, LIST_LINE_MAX)
    : `${unreadCount} new`;
  return [
    "QuickReply",
    "",
    "Tap = Messages",
    statusLine,
    "Double-tap = Exit",
  ].join("\n");
}

/** Inbox screen (Screen 2): 5 rows per page, unread first (the store
 * orders them that way). `selected` is the index into the full list. */
export function inboxScreen(
  messages: InboxMessage[],
  selected: number,
  pageStart: number,
): string {
  if (messages.length === 0) {
    return ["No new messages", "", "Long-press = Home"].join("\n");
  }
  const lines = [`Inbox (${messages.length})`, ""];
  const page = messages.slice(pageStart, pageStart + INBOX_PAGE_SIZE);
  page.forEach((m, i) => {
    const idx = pageStart + i;
    const marker = idx === selected ? ">" : " ";
    const prefix = `${marker} ${idx + 1}. ${m.chat_title} — `;
    const maxText = LIST_LINE_MAX - prefix.length;
    const text =
      firstLine(m.text).length > maxText && maxText > 3
        ? `${firstLine(m.text).slice(0, maxText - 3)}...`
        : firstLine(m.text);
    lines.push(`${prefix}${text}`);
  });
  lines.push("", "Tap = Open   Swipe = Move", "Long-press = Home");
  return lines.join("\n");
}

/** Message screen (Screen 3): sender + wrapped text + action footer. */
export function messageScreen(m: InboxMessage): string {
  const body = wrapText(`${m.sender_name}: ${m.text}`, LIST_LINE_MAX, 3);
  return [
    m.chat_title,
    "",
    ...body,
    "",
    "Tap = Reply   Swipe up = Voice",
  ].join("\n");
}

/** Reply menu (Screen 4): the 5 canned replies, `"> "` on the selected one. */
export function replyMenuScreen(
  chatTitle: string,
  replies: string[],
  selected: number,
): string {
  const lines = [`Reply to ${chatTitle}:`, ""];
  replies.forEach((reply, i) => {
    const marker = i === selected ? ">" : " ";
    lines.push(`${marker} ${reply}`);
  });
  lines.push("", "Swipe = Pick   Tap = Send", "Long-press = Back");
  return lines.join("\n");
}

/** Receipt screen (Screen 7): the sent time + the reply actually sent. */
export function receiptScreen(
  chatTitle: string,
  replyText: string,
  sentAt: Date,
): string {
  const hh = String(sentAt.getHours()).padStart(2, "0");
  const mm = String(sentAt.getMinutes()).padStart(2, "0");
  return [`Sent ✓ ${hh}:${mm}`, "", `${chatTitle}: ${replyText}`].join("\n");
}

/** Error screen (Screen 8): the failure + how to recover. */
export function errorScreen(message: string): string {
  return [message, "", "Tap = Retry", "Long-press = Back"].join("\n");
}

/** Transient screen while a canned send waits for the receipt. */
export function sendingScreen(): string {
  return "Sending...";
}
