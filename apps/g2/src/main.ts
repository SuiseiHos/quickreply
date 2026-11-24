// QuickReply — reply to Telegram messages from Even G2 glasses.
// Entry point: bridge init, Home screen, tap handling, server WebSocket.
// Task 1: Home only. Task 3 adds inbox/message/menu; Task 5 adds voice.

import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  StartUpPageCreateResult,
  TextContainerProperty,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from "@evenrealities/even_hub_sdk";
import { homeScreen } from "./screens";
import { connectWs } from "./ws";

const HOME_CONTAINER_ID = 1;
const HOME_CONTAINER_NAME = "home";
// Backend WebSocket URL. Local dev defaults to the server on this machine;
// the packaged build sets VITE_SERVER_WS_URL to the deployed backend
// (wss://<host>). No secret ever lives here.
const SERVER_WS_URL =
  import.meta.env.VITE_SERVER_WS_URL ?? "ws://localhost:3000";

/** Last tap timestamp (ms); dedupes one physical tap delivered twice. */
let lastTapAt = 0;

/** Live count of unread messages, from the backend. */
let unreadCount = 0;

function handleTap(bridge: EvenAppBridge): void {
  const now = Date.now();
  if (now - lastTapAt < 500) return;
  lastTapAt = now;
  // Task 3: tap on Home opens the inbox. Nothing yet in Task 1.
  void bridge;
}

/** Connect to the backend; Task 2 wires the inbox messages here. */
function connectServerWs(bridge: EvenAppBridge): void {
  let ws: WebSocket;
  try {
    ws = connectWs(SERVER_WS_URL);
  } catch (err) {
    console.error("[QuickReply] WS connect failed:", err);
    setTimeout(() => connectServerWs(bridge), 2000);
    return;
  }
  ws.onopen = () => {
    // Task 2: ask for the inbox here.
  };
  ws.onmessage = (event) => {
    // Task 2: handle {type:"inbox"} / {type:"message"} here.
    void event;
  };
  ws.onclose = () => {
    // Reconnect so a server restart mid-demo does not strand the app.
    setTimeout(() => connectServerWs(bridge), 2000);
  };
  ws.onerror = () => {
    // onclose follows and handles the retry; log once for diagnostics.
    console.error("[QuickReply] WS error, will retry");
  };
}

export async function initBridge(): Promise<void> {
  const bridge: EvenAppBridge = await waitForEvenAppBridge();

  const result = await bridge.createStartUpPageContainer(
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

  connectServerWs(bridge);

  bridge.onEvenHubEvent((event) => {
    // Tap gestures arrive as sysEvent (eventType + eventSource), not as
    // textEvent: the simulator delivers a temple tap as
    // sysEvent { eventSource: GLASSES_R, eventType: <absent> }.
    // CLICK_EVENT is 0 and is normalised to undefined in some host paths,
    // so accept both 0 and undefined as a tap. The textEvent branch is
    // kept for hosts that deliver the tap on the container instead; a
    // 500 ms dedupe window makes one physical tap count once even if
    // both forms arrive. Swipes are SCROLL_TOP_EVENT (up) and
    // SCROLL_BOTTOM_EVENT (down); long-press is LONG_PRESS_EVENT.
    let eventType: OsEventTypeList | undefined;
    const sys = event.sysEvent;
    if (sys && sys.eventSource !== undefined) {
      eventType = sys.eventType;
    } else {
      const textEvent = event.textEvent;
      if (!textEvent || textEvent.containerName !== HOME_CONTAINER_NAME) return;
      eventType = textEvent.eventType;
    }
    if (eventType === OsEventTypeList.CLICK_EVENT || eventType === undefined) {
      handleTap(bridge);
    } else if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      void bridge.shutDownPageContainer(1);
    }
    // Swipes and long-press: no screens to move to yet (Task 3).
  });
}

// Phone WebView fallback: show the same Home text when the page is opened
// outside the glasses (the glasses UI is driven through the bridge above).
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
