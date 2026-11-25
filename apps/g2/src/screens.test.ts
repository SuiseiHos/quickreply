import { test, expect } from "vitest";
import {
  homeScreen,
  inboxScreen,
  messageScreen,
  messageBodyLines,
  messagePageCount,
  pendingSendScreen,
  replyMenuScreen,
  receiptScreen,
  sendingScreen,
  errorScreen,
  recordingScreen,
  reviewScreen,
  transcribingScreen,
  sendError,
  editHintScreen,
  repliesForChat,
  wrapText,
} from "./screens.js";

test("homeScreen shows QuickReply with 0 new messages", () => {
  expect(homeScreen(0)).toBe(
    ["QuickReply", "", "Tap = Messages", "0 new", "Double-tap = Exit"].join(
      "\n",
    ),
  );
});

test("homeScreen shows the unread count", () => {
  expect(homeScreen(3)).toBe(
    ["QuickReply", "", "Tap = Messages", "3 new", "Double-tap = Exit"].join(
      "\n",
    ),
  );
});

test("homeScreen shows the latest message preview when one just arrived", () => {
  expect(
    homeScreen(2, { chatTitle: "Ops", firstLine: "Server is down" }),
  ).toBe(
    [
      "QuickReply",
      "",
      "Tap = Messages",
      "New from Ops: Server is down",
      "Double-tap = Exit",
    ].join("\n"),
  );
});

const INBOX_MSG = {
  id: "-123:7",
  update_id: 1001,
  chat_id: -123,
  chat_title: "Ops",
  sender_id: 555,
  sender_name: "Ani",
  text: "hello from the group",
  created_at: new Date(1795524000 * 1000).toISOString(),
  read: 0,
};

test("inboxScreen shows the empty state with no messages", () => {
  expect(inboxScreen([], 0, 0)).toBe(
    ["No new messages", "", "Long-press = Home"].join("\n"),
  );
});

test("inboxScreen lists 5 rows per page with the selected row marked", () => {
  const messages = [
    INBOX_MSG,
    { ...INBOX_MSG, id: "-123:8", update_id: 1002, text: "second message here" },
    { ...INBOX_MSG, id: "-456:1", update_id: 1003, chat_id: -456, chat_title: "Alerts", text: "alert!" },
  ];
  expect(inboxScreen(messages, 1, 0)).toBe(
    [
      "Inbox (3)",
      "",
      "  1. Ops — hello from the group",
      "> 2. Ops — second message here",
      "  3. Alerts — alert!",
      "",
      "Tap = Open   Swipe = Move",
      "Long-press = Home",
    ].join("\n"),
  );
});

test("inboxScreen prefixes a VIP sender's row with VIP", () => {
  const messages = [
    INBOX_MSG,
    { ...INBOX_MSG, id: "-123:8", update_id: 1002, sender_id: 777, sender_name: "Budi", text: "from budi" },
  ];
  const screen = inboxScreen(messages, 0, 0, [555]);
  expect(screen.split("\n")[2]).toBe("> 1. VIP Ops — hello from the group");
  expect(screen.split("\n")[3]).toBe("  2. Ops — from budi");
});

test("inboxScreen prefixes an urgent row with !", () => {
  const messages = [
    { ...INBOX_MSG, urgent: true, text: "server is down" },
    { ...INBOX_MSG, id: "-123:8", update_id: 1002, text: "lunch?" },
  ];
  const screen = inboxScreen(messages, 0, 0);
  expect(screen.split("\n")[2]).toBe("> 1. ! Ops — server is down");
  expect(screen.split("\n")[3]).toBe("  2. Ops — lunch?");
});

test("inboxScreen truncates a long first line to 64 chars", () => {
  const long = { ...INBOX_MSG, text: "word ".repeat(30) };
  const screen = inboxScreen([long], 0, 0);
  const row = screen.split("\n")[2];
  expect(row.length).toBeLessThanOrEqual(64);
  expect(row.endsWith("...")).toBe(true);
});

test("inboxScreen shows the second page when pageStart moves", () => {
  const messages = Array.from({ length: 7 }, (_, i) => ({
    ...INBOX_MSG,
    id: `-123:${i}`,
    update_id: 1000 + i,
    text: `message ${i}`,
  }));
  const screen = inboxScreen(messages, 5, 5);
  expect(screen).toContain("Inbox (7)");
  expect(screen).toContain("> 6. Ops — message 5");
  expect(screen).toContain("  7. Ops — message 6");
  expect(screen).not.toContain("message 0");
});

test("messageScreen shows sender and wrapped text", () => {
  expect(messageScreen(INBOX_MSG)).toBe(
    [
      "Ops",
      "",
      "Ani: hello from the group",
      "",
      "Tap = Reply   Swipe up = Voice",
    ].join("\n"),
  );
});

test("messageScreen paginates a long message instead of cutting it", () => {
  // Eight ~57-char sentences with words unique to each sentence, so no
  // wrapped line is a substring of another. The greedy wrap packs them
  // into 8+ lines, i.e. 3 pages of 3 lines. Every wrapped line must
  // appear on exactly one page, and the footer must say where to swipe.
  const sentences = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"].map(
    (tag, i) =>
      `${tag} ` +
      Array.from({ length: 11 }, (_, j) => `w${i + 1}${"abcdefghijk"[j]}${"abcdefghijk"[j]}`).join(" "),
  );
  const long = { ...INBOX_MSG, text: sentences.join(" ") };
  const lines = messageBodyLines(long);
  expect(lines.length).toBeGreaterThan(3);
  const pageCount = messagePageCount(long);
  expect(pageCount).toBe(Math.ceil(lines.length / 3));
  expect(pageCount).toBeGreaterThanOrEqual(2);

  for (let p = 0; p < pageCount; p++) {
    const screen = messageScreen(long, p);
    const shown = lines.slice(p * 3, p * 3 + 3);
    const hidden = lines.filter((l) => !shown.includes(l));
    for (const l of shown) expect(screen).toContain(l);
    for (const l of hidden) expect(screen).not.toContain(l);
    for (const line of screen.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(64);
    }
    if (p === 0) {
      expect(screen).toContain(`Swipe down = More (1/${pageCount})`);
    } else if (p === pageCount - 1) {
      expect(screen).toContain("Swipe up = Back");
      expect(screen).toContain(`Swipe down = Inbox (${pageCount}/${pageCount})`);
    } else {
      expect(screen).toContain("Swipe up = Back");
      expect(screen).toContain(`Swipe down = More (${p + 1}/${pageCount})`);
    }
  }

  expect(messageScreen(long, 0)).toContain("S1");
  expect(messageScreen(long, pageCount - 1)).toContain("S8");
  expect(messageScreen(long, 0)).not.toContain("S8");
  expect(messageScreen(long, pageCount - 1)).not.toContain("S1");
});

test("messageScreen clamps an out-of-range page and counts one page for short text", () => {
  expect(messagePageCount(INBOX_MSG)).toBe(1);
  expect(messageScreen(INBOX_MSG, 5)).toBe(messageScreen(INBOX_MSG, 0));
  expect(messageScreen(INBOX_MSG, -1)).toBe(messageScreen(INBOX_MSG, 0));
});

test("replyMenuScreen marks the selected reply with '> '", () => {
  const replies = ["On my way", "Noted, will check", "Can't talk now", "Yes", "No"];
  expect(replyMenuScreen("Ops", replies, 2)).toBe(
    [
      "Reply to Ops:",
      "",
      "  On my way",
      "  Noted, will check",
      "> Can't talk now",
      "  Yes",
      "  No",
      "",
      "Swipe = Pick   Tap = Send",
      "Long-press = Back",
    ].join("\n"),
  );
});

test("receiptScreen shows the sent time and the reply actually sent", () => {
  const sentAt = new Date(2026, 10, 24, 19, 55);
  expect(receiptScreen("Ops", "On my way", sentAt)).toBe(
    ["Sent 19:55", "", "Ops: On my way"].join("\n"),
  );
});

test("pendingSendScreen shows the cancel hint", () => {
  expect(pendingSendScreen()).toBe(
    ["Sending...", "", "Tap again to cancel"].join("\n"),
  );
});

test("sendingScreen shows a waiting line", () => {
  expect(sendingScreen()).toBe("Sending...");
});

test("wrapText breaks on word boundaries and caps the line count", () => {
  expect(wrapText("hello world", 64, 3)).toEqual(["hello world"]);
  const wrapped = wrapText("word ".repeat(40).trim(), 64, 3);
  expect(wrapped).toHaveLength(3);
  expect(wrapped.every((l) => l.length <= 64)).toBe(true);
  expect(wrapped[2].endsWith("...")).toBe(true);
});

test("errorScreen shows the failure and the retry gesture", () => {
  expect(errorScreen("Send failed. Tap to retry.")).toBe(
    ["Send failed. Tap to retry.", "", "Tap = Retry", "Long-press = Back"].join("\n"),
  );
});

// --- voice screens (recording / review / transcribing / edit). ---

test("recordingScreen shows REC and the chat being answered", () => {
  expect(recordingScreen("Ops")).toBe(
    ["REC", "", "To Ops:", "Speak now", "", "Tap = Stop"].join("\n"),
  );
});

test("reviewScreen shows the chat, the transcript and the three actions", () => {
  expect(reviewScreen("Ops", "On my way, see you soon.")).toBe(
    [
      "To Ops:",
      "",
      "On my way, see you soon.",
      "",
      "Tap = Send   Swipe up = Edit",
      "Swipe down = Discard",
    ].join("\n"),
  );
});

test("reviewScreen wraps a long transcript to 3 lines", () => {
  const screen = reviewScreen("Ops", "word ".repeat(40).trim());
  const lines = screen.split("\n");
  expect(lines.length).toBeLessThanOrEqual(8);
  expect(lines.every((l) => l.length <= 64)).toBe(true);
});

test("transcribingScreen shows a waiting line", () => {
  expect(transcribingScreen()).toBe("Transcribing...");
});

test("editHintScreen points at the phone panel", () => {
  expect(editHintScreen()).toBe(
    [
      "Edit on phone",
      "",
      "Change the reply on",
      "the phone, then Save",
      "",
      "Tap = Back",
    ].join("\n"),
  );
});

// no line may exceed 64 chars, even with a 60-char chat title
// and a 64-char canned reply (the old inbox fallback returned the full
// first line, and the menu/receipt rendered the title untruncated).
test("no screen line exceeds 64 chars with a long chat title", () => {
  const longTitle = "A".repeat(60);
  const longMessage = {
    id: "-123:7",
    chat_id: -123,
    chat_title: longTitle,
    sender_id: 555,
    sender_name: "Ani",
    text: "B".repeat(200),
    created_at: "2026-11-24T13:00:00.000Z",
    read: 0,
  };
  const screens = [
    inboxScreen([longMessage], 0, 0),
    messageScreen(longMessage),
    replyMenuScreen(longTitle, ["C".repeat(64), "Yes", "No", "On my way", "Noted"], 0),
    receiptScreen(longTitle, "D".repeat(64), new Date(2026, 10, 24, 20, 14)),
    recordingScreen(longTitle),
    reviewScreen(longTitle, "E".repeat(200)),
  ];
  for (const screen of screens) {
    for (const line of screen.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(64);
    }
  }
});

test("repliesForChat returns the chat's own set when it has one", () => {
  const work = ["On it", "In a meeting", "Will check", "Yes", "No"];
  const global = ["On my way", "Noted, will check", "Can't talk now", "Yes", "No"];
  expect(repliesForChat({ "-123": work }, -123, global)).toEqual(work);
});

test("repliesForChat falls back to the global set for other chats", () => {
  const work = ["On it", "In a meeting", "Will check", "Yes", "No"];
  const global = ["On my way", "Noted, will check", "Can't talk now", "Yes", "No"];
  expect(repliesForChat({ "-123": work }, -999, global)).toEqual(global);
  expect(repliesForChat({}, -123, global)).toEqual(global);
});

test("sendError maps every send-error code to a retryable error screen", () => {
  expect(sendError("send-failed", "canned")).toEqual({
    text: "Send failed. Tap to retry.",
    retry: "send",
  });
  expect(sendError("business-unavailable", "canned")).toEqual({
    text: "Business disconnected. Tap to retry.",
    retry: "send",
  });
  // A dead connection is the problem, not the recording — voice retries
  // the send too.
  expect(sendError("business-unavailable", "voice")).toEqual({
    text: "Business disconnected. Tap to retry.",
    retry: "send",
  });
  expect(sendError("unknown-chat", "canned")).toEqual({
    text: "Unknown chat. Tap to retry.",
    retry: "send",
  });
  expect(sendError("empty", "voice")).toEqual({
    text: "Nothing heard — try again",
    retry: "send",
  });
  expect(sendError("too-long", "voice")).toEqual({
    text: "Too long. Edit it on the phone.",
    retry: "record",
  });
  expect(sendError("too-long", "canned")).toEqual({
    text: "Too long. Edit it on the phone.",
    retry: "send",
  });
  // Unknown future code: generic retryable failure, never a silent stall.
  expect(sendError("weird-future-code", "canned")).toEqual({
    text: "Send failed. Tap to retry.",
    retry: "send",
  });
});
