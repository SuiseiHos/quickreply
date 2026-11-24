// QuickReply — reply to Telegram messages from Even G2 glasses.
// State machine: home / inbox / message / menu / sending / receipt / error.
// Task 3: C2 screens. Task 4: send path + receipt. Task 5: voice mode.

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
  errorScreen,
  homeScreen,
  inboxScreen,
  messageScreen,
  receiptScreen,
  replyMenuScreen,
  sendingScreen,
  type InboxMessage,
} from "./screens";
import { renderReplyPanel, setPanelStatus } from "./phone-panel";

const HOME_CONTAINER_ID = 1;
const HOME_CONTAINER_NAME = "home";
const INBOX_PAGE_SIZE = 5;
const RECEIPT_HOLD_MS = 5000;
// Backend WebSocket URL. Local dev defaults to the server on this machine;
// the packaged build sets VITE_SERVER_WS_URL to the deployed backend
// (wss://<host>). No secret ever lives here.
const SERVER_WS_URL =
  import.meta.env.VITE_SERVER_WS_URL ?? "ws://localhost:3000";

/** Receipt payload (defined here, produced by the server in Task 4). */
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
  | "sending"
  | "receipt"
  | "error";

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
let unreadCount = 0;
let latest: { chatTitle: string; firstLine: string } | undefined;
let inboxSelected = 0;
let inboxPageStart = 0;
let currentMessage: InboxMessage | null = null;
let menuSelected = 0;
let receiptTimer: ReturnType<typeof setTimeout> | null = null;
let lastSend: {
  messageId: string;
  slot: number;
  idempotencyKey: string;
} | null = null;
let errorText = "Send failed. Tap to retry.";
let receipt: { chatTitle: string; text: string; sentAt: string } | null = null;
let savePending = false;
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
      return inboxScreen(messages, inboxSelected, inboxPageStart);
    case "message":
      return currentMessage
        ? messageScreen(currentMessage)
        : homeScreen(unreadCount);
    case "menu":
      return currentMessage
        ? replyMenuScreen(currentMessage.chat_title, replies, menuSelected)
        : homeScreen(unreadCount);
    case "sending":
      return sendingScreen();
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
  const chats = [...new Set(messages.map((m) => m.chat_title))];
  renderReplyPanel(replies, chats, {
    onSave: (next) => {
      savePending = true;
      setPanelStatus("Saving...");
      sendToServer({ type: "update-replies", replies: next });
    },
  });
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

function sendCanned(): void {
  if (!currentMessage) return;
  const key = newIdempotencyKey();
  lastSend = { messageId: currentMessage.id, slot: menuSelected, idempotencyKey: key };
  screen = "sending";
  sendToServer({
    type: "send-canned",
    messageId: currentMessage.id,
    slot: menuSelected,
    idempotencyKey: key,
  });
  render();
}

function retrySend(): void {
  if (!lastSend) return;
  screen = "sending";
  sendToServer({
    type: "send-canned",
    messageId: lastSend.messageId,
    slot: lastSend.slot,
    idempotencyKey: lastSend.idempotencyKey,
  });
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
      sendCanned();
      break;
    case "error":
      retrySend();
      break;
    case "sending":
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
      // Task 5: voice recording. Nothing yet.
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
      goInbox();
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
    case "sending":
      if (currentMessage) {
        screen = "menu";
        render();
      }
      break;
    case "error":
      if (currentMessage) {
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
    const payload = msg as { messages?: unknown; replies?: unknown };
    if (Array.isArray(payload.messages)) {
      messages = payload.messages as InboxMessage[];
    }
    if (Array.isArray(payload.replies)) {
      replies = payload.replies as string[];
    }
    unreadCount = messages.filter((m) => m.read === 0).length;
    inboxSelected = 0;
    inboxPageStart = 0;
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
      setPanelStatus("Saved");
      savePending = false;
    }
    render();
  } else if (type === "receipt") {
    // A receipt only answers a send in flight: never let a late receipt
    // clobber another screen (the CallIt transcript-clobber class).
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
    if (code === "send-failed") {
      errorText = "Send failed. Tap to retry.";
    } else if (code === "too-long") {
      errorText = "Too long. Edit it on the phone.";
    } else if (code === "empty") {
      errorText = "Nothing heard. Tap to try again.";
    } else if (code === "unknown-chat") {
      errorText = "Unknown chat. Tap to retry.";
    } else if (code === "bad-replies") {
      if (savePending) {
        setPanelStatus("Each reply must be 1-64 characters.");
        savePending = false;
      }
      return;
    } else {
      return;
    }
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
    // live container. (Observed 24 Nov 2026 in CallIt: the reload's init
    // threw here and every tap after it was silently ignored.)
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
    // eventSource. Requiring eventSource (the CallIt shape) silently
    // drops long-presses. (Diagnosed 24 Nov 2026 from /api/console.)
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
