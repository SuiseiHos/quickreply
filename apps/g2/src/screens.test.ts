import { test, expect } from "vitest";
import {
  homeScreen,
  inboxScreen,
  messageScreen,
  replyMenuScreen,
  receiptScreen,
  sendingScreen,
  errorScreen,
  recordingScreen,
  reviewScreen,
  transcribingScreen,
  editHintScreen,
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

test("messageScreen wraps long text to 3 lines with an ellipsis", () => {
  const long = { ...INBOX_MSG, text: "word ".repeat(40).trim() };
  const screen = messageScreen(long);
  const lines = screen.split("\n");
  expect(lines.length).toBeLessThanOrEqual(7);
  expect(lines.some((l) => l.length > 64)).toBe(false);
  expect(lines.join("\n")).toContain("...");
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

// --- Task 5: voice screens (recording / review / transcribing / edit). ---

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
