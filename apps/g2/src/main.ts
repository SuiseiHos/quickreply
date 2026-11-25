// QuickReply — reply to Telegram messages from Even G2 glasses.
// State machine: home / inbox / message / menu / sending / receipt / error.

import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { connectWs } from "./ws";
import {
  editHintScreen,
  errorScreen,
  homeScreen,
  inboxScreen,
  messageScreen,
  messagePageCount,
  pendingSendScreen,
  receiptScreen,
  recordingScreen,
  replyMenuScreen,
  reviewScreen,
  sendingScreen,
  transcribingScreen,
  sendError,
  repliesForChat,
  type InboxMessage,
} from "./screens";
import { createUndoWindow, type UndoWindow } from "./undo";
import { renderReplyPanel, setPanelStatus, type PanelBusinessConnection, type PanelChat, type PanelChatReplies, type PanelSender } from "./phone-panel";

const HOME_CONTAINER_ID = 1;
const HOME_CONTAINER_NAME = "home";
const INBOX_PAGE_SIZE = 5;
const RECEIPT_HOLD_MS = 5000;
// Backend WebSocket URL. Local dev defaults to the server on this machine;
// the packaged build sets VITE_SERVER_WS_URL to the deployed backend
// (wss://<host>). No secret ever lives here.
const SERVER_WS_URL =
  import.meta.env.VITE_SERVER_WS_URL ?? "ws://localhost:3000";

/** Receipt payload (defined here, produced by the server). */
type ReceiptMessage = {
  type: "receipt";
  messageId: string;
  chatTitle: string;
  text: string;
  sentAt: string;
};

type Screen =
  | "home"
  | "inbox"
  | "message"
  | "menu"
  | "confirming"
  | "sending"
  | "receipt"
  | "error"
  | "recording"
  | "review"
  | "transcribing"
  | "edit-hint";

let bridge: EvenAppBridge | null = null;
let serverWs: WebSocket | null = null;
let screen: Screen = "home";
let messages: InboxMessage[] = [];
let replies: string[] = [
  "On my way",
  "Noted, will check",
  "Can't talk now",
  "Yes",
  "No",
];
/** Chats the bot has seen, with their allowlist flags. */
let chats: PanelChat[] = [];
let senders: PanelSender[] = [];
let vips: number[] = [];
let keywords: string[] = [];
let keywordsSavePending = false;
let quietHours: { start: string; end: string } | null = null;
let quietHoursSavePending = false;
let businessConnections: PanelBusinessConnection[] = [];
/** Per-chat reply sets, by chat id (chats without one use `replies`). */
let chatReplies: Record<number, string[]> = {};
let chatRepliesSavePending = false;
let unreadCount = 0;
let latest: { chatTitle: string; firstLine: string } | undefined;
let inboxSelected = 0;
let inboxPageStart = 0;
let currentMessage: InboxMessage | null = null;
/** Which 3-line page of the current message is on screen (0-based). */
let messagePage = 0;
let menuSelected = 0;
let receiptTimer: ReturnType<typeof setTimeout> | null = null;
let lastSend:
  | { kind: "canned"; messageId: string; slot: number; idempotencyKey: string }
  | { kind: "voice"; messageId: string; text: string; idempotencyKey: string }
  | null = null;
let errorText = "Send failed. Tap to retry.";
/** A canned send waiting out its 2 s undo window (not sent yet). */
let pendingCanned:
  | { messageId: string; slot: number; idempotencyKey: string }
  | null = null;
/** The undo window for the pending canned send (2 s, 300 ms arm delay). */
const undoWindow: UndoWindow = createUndoWindow(2000);
let undoTimer: ReturnType<typeof setTimeout> | null = null;
/** Wall-clock ms when the current undo window was armed (for M1's
 * reschedule math — the timer can fire a hair before the window ends). */
let undoArmedAt = 0;
/** What the error screen's tap retries: re-send, or re-record (voice). */
let errorRetry: "send" | "record" | null = null;
let receipt: { chatTitle: string; text: string; sentAt: string } | null = null;
let savePending = false;
/** The message a voice reply answers (recording → review → send). */
let voiceMessage: InboxMessage | null = null;
/** The transcript under review (also shown in the phone panel). */
let reviewTranscript = "";
/** A phone-panel voice edit is waiting for its server reply. */
let transcriptSavePending = false;
/** Last tap timestamp (ms); dedupes one physical tap delivered twice. */
let lastTapAt = 0;

function showText(content: string): void {
  if (!bridge) return;
  void bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: HOME_CONTAINER_ID,
      containerName: HOME_CONTAINER_NAME,
      content,
    }),
  );
}

function currentScreenText(): string {
  switch (screen) {
    case "home":
      return homeScreen(unreadCount, latest);
    case "inbox":
      return inboxScreen(messages, inboxSelected, inboxPageStart, vips);
    case "message":
      return currentMessage
        ? messageScreen(currentMessage, messagePage)
        : homeScreen(unreadCount);
    case "menu":
      return currentMessage
        ? replyMenuScreen(currentMessage.chat_title, repliesForChat(chatReplies, currentMessage.chat_id, replies), menuSelected)
        : homeScreen(unreadCount);
    case "confirming":
      return pendingSendScreen();
    case "sending":
      return sendingScreen();
    case "recording":
      return voiceMessage
        ? recordingScreen(voiceMessage.chat_title)
        : homeScreen(unreadCount);
    case "transcribing":
      return transcribingScreen();
    case "review":
      return voiceMessage
        ? reviewScreen(voiceMessage.chat_title, reviewTranscript)
        : homeScreen(unreadCount);
    case "edit-hint":
      return editHintScreen();
    case "receipt":
      return receipt
        ? receiptScreen(receipt.chatTitle, receipt.text, new Date(receipt.sentAt))
        : homeScreen(unreadCount);
    case "error":
      return errorScreen(errorText);
  }
}

function render(): void {
  showText(currentScreenText());
  renderReplyPanel(replies, chats, {
    onSave: (next) => {
      savePending = true;
      setPanelStatus("Saving...");
      sendToServer({ type: "update-replies", replies: next });
    },
    onSaveVoice: (messageId, text) => {
      transcriptSavePending = true;
      setPanelStatus("Saving...");
      sendToServer({ type: "update-transcript", messageId, text });
    },
    onToggleChat: (chatId, allowed) => {
      sendToServer({ type: "set-chat-allowed", chat_id: chatId, allowed });
    },
    onToggleVip: (senderId, vip) => {
      sendToServer({ type: "set-vip", sender_id: senderId, vip });
    },
    onSaveKeywords: (text) => {
      keywordsSavePending = true;
      setPanelStatus("Saving...");
      sendToServer({ type: "set-keywords", keywords: text });
    },
    onSaveQuietHours: (start, end) => {
      quietHoursSavePending = true;
      setPanelStatus("Saving...");
      sendToServer({ type: "set-quiet-hours", start, end });
    },
    onSaveChatReplies: (chatId, next) => {
      chatRepliesSavePending = true;
      setPanelStatus("Saving...");
      sendToServer({ type: "set-chat-replies", chat_id: chatId, replies: next });
    },
    onClearChatReplies: (chatId) => {
      sendToServer({ type: "clear-chat-replies", chat_id: chatId });
    },
  },
  // The phone panel shows the voice-reply editor only while a review
  // is active (or its too-long error is showing).
  (screen === "review" || screen === "edit-hint" || (screen === "error" && errorRetry === "record")) && voiceMessage
    ? { messageId: voiceMessage.id, text: reviewTranscript }
    : null,
  { senders, keywords, quietHours, businessConnections, chatReplies: Object.entries(chatReplies).map(([chat_id, replies]) => ({ chat_id: Number(chat_id), replies })) },
  );
}

function sendToServer(msg: unknown): void {
  if (serverWs && serverWs.readyState === WebSocket.OPEN) {
    serverWs.send(JSON.stringify(msg));
  } else {
    console.error("[QuickReply] WS not open, cannot send:", msg);
  }
}

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

function clearReceiptTimer(): void {
  if (receiptTimer) {
    clearTimeout(receiptTimer);
    receiptTimer = null;
  }
}

function goHome(): void {
  clearReceiptTimer();
  screen = "home";
  latest = undefined;
  render();
}

function goInbox(): void {
  clearReceiptTimer();
  screen = "inbox";
  latest = undefined;
  inboxSelected = 0;
  inboxPageStart = 0;
  render();
}

function openMessage(m: InboxMessage): void {
  clearReceiptTimer();
  currentMessage = m;
  messagePage = 0;
  screen = "message";
  sendToServer({ type: "open-message", messageId: m.id });
  render();
}

function openMenu(): void {
  clearReceiptTimer();
  menuSelected = 0;
  screen = "menu";
  render();
}

function clearUndoTimer(): void {
  if (undoTimer) {
    clearTimeout(undoTimer);
    undoTimer = null;
  }
}

/** Tap on a canned reply: arm the 2 s undo window instead of sending.
 * The send fires only when the window expires (firePendingCannedSend);
 * a second tap inside the window cancels it. */
function armCannedSend(): void {
  if (!currentMessage) return;
  const key = newIdempotencyKey();
  pendingCanned = {
    messageId: currentMessage.id,
    slot: menuSelected,
    idempotencyKey: key,
  };
  undoWindow.start(key, Date.now());
  undoArmedAt = Date.now();
  screen = "confirming";
  clearUndoTimer();
  undoTimer = setTimeout(firePendingCannedSend, 2000);
  render();
}

/** The undo window expired: fire the pending canned send exactly as the
 * old immediate send did (same gate, same receipt, same idempotency key). */
function firePendingCannedSend(): void {
  if (!pendingCanned) return;
  const key = undoWindow.expire(Date.now());
  if (key === null) {
    // The timer fired a hair before the window ended (or the clock
    // jumped back): wait out the rest instead of stranding the
    // confirming screen with a send that never fires.
    const remaining = 2000 - (Date.now() - undoArmedAt);
    undoTimer = setTimeout(firePendingCannedSend, Math.max(remaining, 50));
    return;
  }
  const pending = pendingCanned;
  pendingCanned = null;
  clearUndoTimer();
  lastSend = {
    kind: "canned",
    messageId: pending.messageId,
    slot: pending.slot,
    idempotencyKey: pending.idempotencyKey,
  };
  screen = "sending";
  sendToServer({
    type: "send-canned",
    messageId: pending.messageId,
    slot: pending.slot,
    idempotencyKey: pending.idempotencyKey,
  });
  render();
}

/** Second tap inside the undo window: drop the pending send, back to
 * the reply menu. Nothing was sent, so no idempotency key is consumed. */
function cancelPendingCannedSend(): void {
  if (!pendingCanned) return;
  clearUndoTimer();
  undoWindow.clear();
  pendingCanned = null;
  screen = "menu";
  render();
}

/** Start a voice reply: the message screen's swipe-up. On real
 * hardware the mic stream starts here (bridge.audioControl); in the
 * simulator the audio comes from the injection harness. */
function startRecording(): void {
  if (!currentMessage) return;
  voiceMessage = currentMessage;
  reviewTranscript = "";
  screen = "recording";
  render();
}

/** Tap-to-stop: end the mic stream and ask the server to transcribe what
 * it has. The transcript (or the empty/stt-failed error) arrives on the
 * same socket and the guard in handleServerMessage applies it. */
function stopRecording(): void {
  if (!voiceMessage) return;
  screen = "transcribing";
  sendToServer({ type: "audio-end", messageId: voiceMessage.id });
  render();
}

/** Cancel the recording (long-press / swipe down): back to the message
 * and tell the server to drop the buffered PCM for this socket, so a
 * later recording does not transcribe stale audio. */
function cancelRecording(): void {
  sendToServer({ type: "audio-discard" });
  voiceMessage = null;
  reviewTranscript = "";
  screen = "message";
  render();
}

/** Tap on the review screen: send the transcript through the same gate
 * + receipt as a canned reply. */
function sendVoice(): void {
  if (!voiceMessage) return;
  const key = newIdempotencyKey();
  lastSend = { kind: "voice", messageId: voiceMessage.id, text: reviewTranscript, idempotencyKey: key };
  screen = "sending";
  sendToServer({
    type: "send-voice",
    messageId: voiceMessage.id,
    text: reviewTranscript,
    idempotencyKey: key,
  });
  render();
}

/** Discard the review (swipe down / long-press): back to the message. */
function discardReview(): void {
  voiceMessage = null;
  reviewTranscript = "";
  screen = "message";
  render();
}

function retrySend(): void {
  if (!lastSend) return;
  screen = "sending";
  if (lastSend.kind === "canned") {
    sendToServer({
      type: "send-canned",
      messageId: lastSend.messageId,
      slot: lastSend.slot,
      idempotencyKey: lastSend.idempotencyKey,
    });
  } else {
    sendToServer({
      type: "send-voice",
      messageId: lastSend.messageId,
      text: lastSend.text,
      idempotencyKey: lastSend.idempotencyKey,
    });
  }
  render();
}

function moveInboxSelection(delta: number): void {
  if (messages.length === 0) return;
  inboxSelected = Math.max(
    0,
    Math.min(messages.length - 1, inboxSelected + delta),
  );
  if (inboxSelected < inboxPageStart) inboxPageStart = inboxSelected;
  if (inboxSelected >= inboxPageStart + INBOX_PAGE_SIZE) {
    inboxPageStart = inboxSelected - INBOX_PAGE_SIZE + 1;
  }
  render();
}

function cycleMenuSelection(delta: number): void {
  menuSelected =
    (menuSelected + delta + replies.length) % replies.length;
  render();
}

function handleTap(): void {
  // A tap while a canned send waits out its undo window cancels it —
  // and this check runs BEFORE the 500 ms dedupe below, because the
  // cancelling tap is a deliberate second tap, not a duplicate delivery
  // of the first. The window's own 300 ms arm delay swallows the
  // duplicate instead (see undo.ts).
  if (screen === "confirming") {
    if (undoWindow.tap(Date.now()) === "cancelled") {
      cancelPendingCannedSend();
    }
    return;
  }
  const now = Date.now();
  if (now - lastTapAt < 500) return;
  lastTapAt = now;
  switch (screen) {
    case "home":
      goInbox();
      break;
    case "inbox": {
      const m = messages[inboxSelected];
      if (m) openMessage(m);
      break;
    }
    case "message":
      openMenu();
      break;
    case "menu":
      armCannedSend();
      break;
    case "recording":
      stopRecording();
      break;
    case "review":
      sendVoice();
      break;
    case "edit-hint":
      screen = "review";
      render();
      break;
    case "error":
      // A send error retries the send; a voice error re-records.
      if (errorRetry === "record") {
        startRecording();
      } else {
        retrySend();
      }
      break;
    case "sending":
    case "transcribing":
    case "receipt":
      break;
  }
}

function handleSwipeUp(): void {
  switch (screen) {
    case "inbox":
      moveInboxSelection(-1);
      break;
    case "menu":
      cycleMenuSelection(-1);
      break;
    case "message":
      // First page: swipe up starts a voice reply (as before). On a
      // later page it goes back one page instead.
      if (messagePage > 0) {
        messagePage--;
        render();
      } else {
        startRecording();
      }
      break;
    case "review":
      // Edit: the transcript is edited on the phone panel.
      screen = "edit-hint";
      render();
      break;
    default:
      break;
  }
}

function handleSwipeDown(): void {
  switch (screen) {
    case "inbox":
      moveInboxSelection(1);
      break;
    case "menu":
      cycleMenuSelection(1);
      break;
    case "message":
      // Swipe down reads the next page while one is left; on the last
      // page it goes back to the inbox (as before).
      if (
        currentMessage &&
        messagePage < messagePageCount(currentMessage) - 1
      ) {
        messagePage++;
        render();
      } else {
        goInbox();
      }
      break;
    case "recording":
      cancelRecording();
      break;
    case "review":
      discardReview();
      break;
    default:
      break;
  }
}

function handleLongPress(): void {
  switch (screen) {
    case "inbox":
      goHome();
      break;
    case "message":
      goInbox();
      break;
    case "menu":
      if (currentMessage) {
        screen = "message";
        render();
      }
      break;
    case "confirming":
      cancelPendingCannedSend();
      break;
    case "recording":
      cancelRecording();
      break;
    case "transcribing":
      // The transcript may still arrive later; the guard ignores it once
      // the screen has moved on.
      cancelRecording();
      break;
    case "review":
      discardReview();
      break;
    case "edit-hint":
      screen = "review";
      render();
      break;
    case "sending":
      if (currentMessage) {
        screen = "menu";
        render();
      }
      break;
    case "error":
      // Back to where the send started: the menu for canned, the message
      // for voice.
      if (errorRetry === "record") {
        if (currentMessage) {
          screen = "message";
          render();
        }
      } else if (currentMessage) {
        screen = "menu";
        render();
      }
      break;
    case "receipt":
      goHome();
      break;
    default:
      break;
  }
}

function upsertMessage(m: InboxMessage): boolean {
  const existing = messages.findIndex((x) => x.id === m.id);
  if (existing >= 0) {
    messages[existing] = m;
    return false;
  }
  messages.unshift(m);
  return true;
}

function handleServerMessage(raw: string): void {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof msg !== "object" || msg === null) return;
  const type = (msg as { type?: unknown }).type;
  if (type === "inbox") {
    const payload = msg as { messages?: unknown; replies?: unknown; chats?: unknown; senders?: unknown; vips?: unknown; keywords?: unknown; quietHours?: unknown; businessConnections?: unknown; chatReplies?: unknown };
    if (Array.isArray(payload.messages)) {
      messages = payload.messages as InboxMessage[];
    }
    if (Array.isArray(payload.replies)) {
      replies = payload.replies as string[];
    }
    if (Array.isArray(payload.chats)) {
      chats = payload.chats as PanelChat[];
    }
    if (Array.isArray(payload.senders)) {
      senders = payload.senders as PanelSender[];
    }
    if (Array.isArray(payload.vips)) {
      vips = payload.vips as number[];
    }
    if (Array.isArray(payload.keywords)) {
      keywords = payload.keywords as string[];
    }
    if (
      payload.quietHours === null ||
      (typeof payload.quietHours === "object" &&
        payload.quietHours !== null &&
        typeof (payload.quietHours as { start?: unknown }).start === "string" &&
        typeof (payload.quietHours as { end?: unknown }).end === "string")
    ) {
      quietHours = payload.quietHours as { start: string; end: string } | null;
    }
    if (Array.isArray(payload.businessConnections)) {
      businessConnections = payload.businessConnections as PanelBusinessConnection[];
    }
    if (Array.isArray(payload.chatReplies)) {
      chatReplies = {};
      for (const entry of payload.chatReplies as PanelChatReplies[]) {
        if (typeof entry.chat_id === "number" && Array.isArray(entry.replies)) {
          chatReplies[entry.chat_id] = entry.replies;
        }
      }
    }
    unreadCount = messages.filter((m) => m.read === 0).length;
    inboxSelected = 0;
    inboxPageStart = 0;
    render();
  } else if (type === "chat-replies-updated") {
    const payload = msg as { chat_id?: unknown; replies?: unknown };
    if (typeof payload.chat_id === "number") {
      if (Array.isArray(payload.replies)) {
        chatReplies[payload.chat_id] = payload.replies as string[];
      } else if (payload.replies === null) {
        delete chatReplies[payload.chat_id];
      }
    }
    if (chatRepliesSavePending) {
      setPanelStatus("Saved", "ok");
      chatRepliesSavePending = false;
    }
    render();
  } else if (type === "quiet-hours-updated") {
    const next = (msg as { quietHours?: unknown }).quietHours;
    if (
      next === null ||
      (typeof next === "object" &&
        next !== null &&
        typeof (next as { start?: unknown }).start === "string" &&
        typeof (next as { end?: unknown }).end === "string")
    ) {
      quietHours = next as { start: string; end: string } | null;
    }
    if (quietHoursSavePending) {
      setPanelStatus("Saved", "ok");
      quietHoursSavePending = false;
    }
    render();
  } else if (type === "business-connections-updated") {
    const next = (msg as { businessConnections?: unknown }).businessConnections;
    if (Array.isArray(next)) {
      businessConnections = next as PanelBusinessConnection[];
      render();
    }
  } else if (type === "keywords-updated") {
    const next = (msg as { keywords?: unknown }).keywords;
    if (Array.isArray(next)) keywords = next as string[];
    if (keywordsSavePending) {
      setPanelStatus("Saved", "ok");
      keywordsSavePending = false;
    }
    render();
  } else if (type === "chats-updated") {
    const next = (msg as { chats?: unknown }).chats;
    if (Array.isArray(next)) chats = next as PanelChat[];
    render();
  } else if (type === "vips-updated") {
    const payload = msg as { senders?: unknown; vips?: unknown };
    if (Array.isArray(payload.senders)) {
      senders = payload.senders as PanelSender[];
    }
    if (Array.isArray(payload.vips)) {
      vips = payload.vips as number[];
    }
    render();
  } else if (type === "message") {
    const m = (msg as { message?: unknown }).message as InboxMessage;
    if (!m || typeof m !== "object") return;
    const isNew = upsertMessage(m);
    unreadCount = messages.filter((x) => x.read === 0).length;
    if (isNew) {
      latest = {
        chatTitle: m.chat_title,
        firstLine: m.text.split("\n")[0] ?? "",
      };
    }
    if (currentMessage && currentMessage.id === m.id) {
      currentMessage = m;
    }
    render();
  } else if (type === "replies-updated") {
    const next = (msg as { replies?: unknown }).replies;
    if (Array.isArray(next)) replies = next as string[];
    if (savePending) {
      setPanelStatus("Saved", "ok");
      savePending = false;
    }
    render();
  } else if (type === "transcript") {
    // THE clobber guard: a transcript
    // applies ONLY when this screen is recording, reviewing or
    // transcribing for THAT SAME message — never on the receipt, the
    // menu, another message's review, or after a discard. An edited
    // transcript after a too-long voice send also re-opens the review.
    const t = msg as {
      messageId?: unknown;
      chatTitle?: unknown;
      text?: unknown;
    };
    if (typeof t.messageId !== "string" || typeof t.text !== "string") return;
    if (transcriptSavePending) {
      setPanelStatus("Saved", "ok");
      transcriptSavePending = false;
    }
    const answering =
      voiceMessage !== null && voiceMessage.id === t.messageId;
    const onVoiceScreen =
      screen === "recording" || screen === "review" || screen === "transcribing";
    const afterTooLong =
      screen === "error" &&
      errorRetry === "record" &&
      lastSend?.kind === "voice" &&
      lastSend.messageId === t.messageId;
    if ((!answering || !onVoiceScreen) && !afterTooLong) return;
    const found = messages.find((m) => m.id === t.messageId);
    voiceMessage =
      found ??
      ({
        id: t.messageId,
        chat_id: 0,
        chat_title: typeof t.chatTitle === "string" ? t.chatTitle : "",
        sender_id: null,
        sender_name: "",
        text: "",
        created_at: "",
        read: 1,
      } satisfies InboxMessage);
    reviewTranscript = t.text;
    screen = "review";
    render();
  } else if (type === "receipt") {
    // A receipt only answers a send in flight: never let a late receipt
    // clobber another screen (same class of bug as a stray transcript).
    if (screen !== "sending" && screen !== "error") return;
    const r = msg as ReceiptMessage;
    lastSend = null;
    // The receipt shows the reply actually sent, not the message text.
    receipt = { chatTitle: r.chatTitle, text: r.text, sentAt: r.sentAt };
    screen = "receipt";
    render();
    clearReceiptTimer();
    receiptTimer = setTimeout(goHome, RECEIPT_HOLD_MS);
  } else if (type === "error") {
    const code = (msg as { code?: unknown }).code;
    const messageId = (msg as { messageId?: unknown }).messageId;
    if (code === "bad-replies") {
      if (savePending || chatRepliesSavePending) {
        setPanelStatus("Each reply must be 1-64 characters.", "error");
        savePending = false;
        chatRepliesSavePending = false;
      }
      return;
    }
    if (code === "bad-keywords") {
      if (keywordsSavePending) {
        setPanelStatus("Too many keywords, or one is too long.", "error");
        keywordsSavePending = false;
      }
      return;
    }
    if (code === "bad-quiet-hours") {
      if (quietHoursSavePending) {
        setPanelStatus("Quiet hours need two valid times, or both empty.", "error");
        quietHoursSavePending = false;
      }
      return;
    }
    // A voice error (broadcast with the message it answers) takes
    // precedence over a pending panel save: it applies only while
    // recording or transcribing THAT message — NOT on the review screen.
    // A transcript was already accepted there, so an error for that
    // message can only come from a duplicate/stale audio-end; a new
    // recording moves the screen to "recording" first.
    if (typeof messageId === "string") {
      if (!voiceMessage || voiceMessage.id !== messageId) return;
      if (screen !== "recording" && screen !== "transcribing") return;
      if (code === "empty") {
        errorText = "Nothing heard — try again";
      } else if (code === "stt-failed") {
        errorText = "Couldn't hear that. Tap to try again.";
      } else {
        return;
      }
      errorRetry = "record";
      screen = "error";
      render();
      return;
    }
    // A phone-panel voice edit that the server rejected: the panel shows
    // the reason; the glasses screen never changes for it.
    if (transcriptSavePending) {
      if (code === "too-long") setPanelStatus("Too long — shorten it.", "error");
      else if (code === "empty") setPanelStatus("Empty — say something first.", "error");
      else if (code === "unknown-chat") setPanelStatus("Unknown chat.", "error");
      else setPanelStatus("Could not save.", "error");
      transcriptSavePending = false;
      return;
    }
    // A send error (a reply to this socket only): it applies only while a
    // send is in flight or already on the error screen. The mapping is
    // total — any code, including a future one, lands on a retryable
    // error screen, never a silent stall on "Sending…".
    if (screen !== "sending" && screen !== "error") return;
    const err = sendError(
      typeof code === "string" ? code : "send-failed",
      lastSend?.kind ?? null,
    );
    errorText = err.text;
    errorRetry = err.retry;
    screen = "error";
    render();
  }
  // Unknown types are ignored.
}

function connectServerWs(): void {
  let ws: WebSocket;
  try {
    ws = connectWs(SERVER_WS_URL);
  } catch (err) {
    console.error("[QuickReply] WS connect failed:", err);
    setTimeout(connectServerWs, 2000);
    return;
  }
  serverWs = ws;
  ws.onopen = () => {
    sendToServer({ type: "list-inbox" });
  };
  ws.onmessage = (event) => {
    handleServerMessage(String(event.data));
  };
  ws.onclose = () => {
    // Reconnect so a server restart mid-demo does not strand the app.
    setTimeout(connectServerWs, 2000);
  };
  ws.onerror = () => {
    // onclose follows and handles the retry; log once for diagnostics.
    console.error("[QuickReply] WS error, will retry");
  };
}

export async function initBridge(): Promise<void> {
  const localBridge: EvenAppBridge = await waitForEvenAppBridge();
  bridge = localBridge;

  const result = await localBridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 1,
      textObject: [
        new TextContainerProperty({
          xPosition: 0,
          yPosition: 0,
          width: 576,
          height: 288,
          containerID: HOME_CONTAINER_ID,
          containerName: HOME_CONTAINER_NAME,
          zOrderIndex: 1,
          content: homeScreen(unreadCount),
          textColor: 4,
          isEventCapture: 1,
        }),
      ],
    }),
  );
  if (result !== StartUpPageCreateResult.success) {
    // The simulator reloads the page once after the bridge is ready; the
    // first load's container stays on the glasses and the host rejects a
    // second startup page as `invalid` (1). The event handler lives on the
    // bridge, not the container, so keep going instead of aborting: taps
    // still reach this handler and textContainerUpgrade still updates the
    // live container. (Observed on a reload: the init threw here and
    // every tap after it was silently ignored.)
    console.warn(
      "[QuickReply] createStartUpPageContainer returned",
      result,
      "- keeping the existing container",
    );
  }

  render();
  connectServerWs();

  localBridge.onEvenHubEvent((event) => {
    // Tap gestures arrive as sysEvent (eventType + eventSource), not as
    // textEvent: the simulator delivers a temple tap as
    // sysEvent { eventSource: GLASSES_R, eventType: <absent> }.
    // CLICK_EVENT is 0 and is normalised to undefined in some host paths,
    // so accept both 0 and undefined as a tap. The textEvent branch is
    // kept for hosts that deliver the tap on the container instead; a
    // 500 ms dedupe window makes one physical tap count once even if
    // both forms arrive. Swipes are SCROLL_TOP_EVENT (up) and
    // SCROLL_BOTTOM_EVENT (down); long-press is LONG_PRESS_EVENT.
    // A sysEvent is trusted when it carries either field: a tap arrives
    // as sysEvent {eventSource: 1} with NO eventType (→ undefined = tap),
    // while a long-press arrives as sysEvent {eventType: 9} with NO
    // eventSource. Requiring eventSource (as an earlier version did)
    // silently drops long-presses. (Diagnosed from /api/console.)
    let eventType: OsEventTypeList | undefined;
    const sys = event.sysEvent;
    if (sys && (sys.eventSource !== undefined || sys.eventType !== undefined)) {
      eventType = sys.eventType;
    } else {
      const textEvent = event.textEvent;
      if (!textEvent || textEvent.containerName !== HOME_CONTAINER_NAME) return;
      eventType = textEvent.eventType;
    }
    if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
      handleTap();
    } else if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      handleSwipeUp();
    } else if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      handleSwipeDown();
    } else if (eventType === OsEventTypeList.LONG_PRESS_EVENT) {
      handleLongPress();
    } else if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      void localBridge.shutDownPageContainer(1);
    }
  });
}

// Phone WebView fallback: the reply editor (5 slots + chat list) lives in
// #app; the glasses screen is driven through the bridge above.
const appEl = document.querySelector<HTMLDivElement>("#app");
if (appEl) {
  appEl.style.whiteSpace = "pre-line";
  appEl.style.fontFamily = "monospace";
  appEl.textContent = homeScreen(unreadCount);
}

initBridge().catch((err: unknown) => {
  console.error("[QuickReply] bridge init failed:", err);
  if (appEl) {
    appEl.textContent = `${homeScreen(unreadCount)}\n\nBridge unavailable: ${String(err)}`;
  }
});
