// QuickReply backend: Express + WebSocket on one port (Task 2).
// /health + WS router (list-inbox) + Telegram poller pushing new messages
// to all connected glasses. No secret is needed to boot: the poller calls
// the connector helper, which holds the token in the Vault.
import express from "express";
import { createServer as createHttpServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  getMessage,
  getReplies,
  listInbox,
  listKnownChats,
  markRead,
  seedAllowedFromMessages,
  setChatAllowed,
  setReplies,
} from "./message-store.js";
import { sendCanned, sendText, type SendResult } from "./send.js";
import { createAudioHandler, type TranscribeFn } from "./ws-audio.js";
import {
  sendMessage,
  startPoller,
  type SendTelegramFn,
} from "./telegram.js";

const PORT = Number(process.env.PORT ?? 3000);

/** Connected glasses + message routing. Kept separate from the HTTP
 * server so tests can drive it over a real WebSocket without a poller.
 * `sendTelegram` is injectable so tests can use a fake instead of
 * delivering a real message to a real chat. */
export function createHub(opts?: { sendTelegram?: SendTelegramFn }) {
  const clients = new Set<WebSocket>();
  const sendTelegram = opts?.sendTelegram ?? sendMessage;

  async function handleSendCanned(
    ws: WebSocket,
    payload: { messageId?: unknown; slot?: unknown; idempotencyKey?: unknown },
  ): Promise<void> {
    if (
      typeof payload.messageId !== "string" ||
      typeof payload.slot !== "number" ||
      typeof payload.idempotencyKey !== "string"
    ) {
      return;
    }
    let result;
    try {
      result = await sendCanned(
        {
          messageId: payload.messageId,
          slot: payload.slot,
          idempotencyKey: payload.idempotencyKey,
        },
        sendTelegram,
      );
    } catch {
      ws.send(JSON.stringify({ type: "error", code: "send-failed" }));
      return;
    }
    replySendResult(ws, result);
  }

  /** The voice send: free text through the same gate + receipt as canned. */
  async function handleSendVoice(
    ws: WebSocket,
    payload: {
      messageId?: unknown;
      text?: unknown;
      idempotencyKey?: unknown;
    },
  ): Promise<void> {
    if (
      typeof payload.messageId !== "string" ||
      typeof payload.text !== "string" ||
      typeof payload.idempotencyKey !== "string"
    ) {
      return;
    }
    let result;
    try {
      result = await sendText(
        {
          messageId: payload.messageId,
          text: payload.text,
          idempotencyKey: payload.idempotencyKey,
        },
        sendTelegram,
      );
    } catch {
      ws.send(JSON.stringify({ type: "error", code: "send-failed" }));
      return;
    }
    replySendResult(ws, result);
  }

  function replySendResult(ws: WebSocket, result: SendResult): void {
    if (result.ok) {
      ws.send(JSON.stringify({ type: "receipt", ...result.receipt }));
    } else {
      ws.send(JSON.stringify({ type: "error", code: result.code }));
    }
  }

  function broadcast(msg: unknown) {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  function handleMessage(ws: WebSocket, raw: string) {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const type = (msg as { type?: unknown }).type;
    if (type === "list-inbox") {
      ws.send(
        JSON.stringify({
          type: "inbox",
          messages: listInbox(),
          replies: getReplies(),
          chats: listKnownChats(),
        }),
      );
    } else if (type === "set-chat-allowed") {
      // Phone-panel allowlist toggle (Task 8): only the local panel can
      // change it, and only for a chat the bot has already seen. A toggle
      // for an unknown chat is rejected — it means a forged or stale id.
      const chatId = (msg as { chat_id?: unknown }).chat_id;
      const allowed = (msg as { allowed?: unknown }).allowed;
      if (typeof chatId !== "number" || typeof allowed !== "boolean") return;
      if (!setChatAllowed(chatId, allowed)) {
        ws.send(JSON.stringify({ type: "error", code: "unknown-chat" }));
        return;
      }
      broadcast({ type: "chats-updated", chats: listKnownChats() });
    } else if (type === "open-message") {
      const messageId = (msg as { messageId?: unknown }).messageId;
      if (typeof messageId !== "string") return;
      const message = getMessage(messageId);
      if (!message) return;
      markRead(messageId);
      ws.send(JSON.stringify({ type: "message", message }));
    } else if (type === "update-replies") {
      const replies = (msg as { replies?: unknown }).replies;
      if (!Array.isArray(replies)) {
        ws.send(JSON.stringify({ type: "error", code: "bad-replies" }));
        return;
      }
      if (!setReplies(replies as string[])) {
        ws.send(JSON.stringify({ type: "error", code: "bad-replies" }));
        return;
      }
      broadcast({ type: "replies-updated", replies: getReplies() });
    } else if (type === "send-canned") {
      void handleSendCanned(
        ws,
        msg as {
          messageId?: unknown;
          slot?: unknown;
          idempotencyKey?: unknown;
        },
      );
    } else if (type === "send-voice") {
      void handleSendVoice(
        ws,
        msg as {
          messageId?: unknown;
          text?: unknown;
          idempotencyKey?: unknown;
        },
      );
    } else if (type === "update-transcript") {
      // Phone-panel edit of the voice reply under review: validate, then
      // broadcast the edited transcript so the glasses review updates.
      // The gate (G1/G2) runs here, not on the phone.
      const messageId = (msg as { messageId?: unknown }).messageId;
      const text = (msg as { text?: unknown }).text;
      if (typeof messageId !== "string" || typeof text !== "string") return;
      const message = getMessage(messageId);
      if (!message) {
        ws.send(JSON.stringify({ type: "error", code: "unknown-chat" }));
        return;
      }
      if (text.trim().length === 0) {
        ws.send(JSON.stringify({ type: "error", code: "empty" }));
        return;
      }
      if (text.length > 4096) {
        ws.send(JSON.stringify({ type: "error", code: "too-long" }));
        return;
      }
      broadcast({
        type: "transcript",
        messageId,
        chatTitle: message.chat_title,
        text,
      });
    }
    // Unknown types are ignored.
  }

  return {
    addClient(ws: WebSocket) {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
    },
    broadcast,
    handleMessage,
  };
}

export type Hub = ReturnType<typeof createHub>;

/** `transcribe` and `maxPcmBytes` are injectable so tests can use a fake
 * instead of loading the Whisper model, and a small PCM cap. */
export function createServer(
  hub = createHub(),
  audioOpts?: { transcribe?: TranscribeFn; maxPcmBytes?: number },
) {
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const audio = createAudioHandler({
    broadcast: (msg) => hub.broadcast(msg),
    transcribe: audioOpts?.transcribe,
    maxPcmBytes: audioOpts?.maxPcmBytes,
  });

  const server = createHttpServer(app);
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    hub.addClient(ws);
    ws.on("close", () => audio.onClose(ws));
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        audio.onBinary(ws, Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        return;
      }
      const raw = String(data);
      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      // Audio-path text messages are handled by the audio handler first.
      if (audio.onText(ws, msg)) return;
      hub.handleMessage(ws, raw);
    });
  });
  return server;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const hub = createHub();
  const server = createServer(hub);
  // Localhost only (Task 8): the WS is the bot's only control surface —
  // sends, reply edits, allowlist toggles — so it must not be reachable
  // from the network. Correct for the simulator demo (the webview runs on
  // this VM); a public host later needs a shared secret + TLS, not just
  // a bind change.
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`QuickReply server listening on 127.0.0.1:${PORT}`);
  });
  // Grandfather the chats the bot already serves (Task 8): they were added
  // by the owner before the allowlist existed.
  const seeded = seedAllowedFromMessages();
  if (seeded > 0) {
    console.log(`[QuickReply] allowlist: grandfathered ${seeded} chat(s)`);
  }
  // Telegram poller: pushes each new message to all connected glasses.
  startPoller({
    onMessage: (message) => {
      console.log(
        `[QuickReply] new message from ${message.chat_title}: ${message.text.slice(0, 60)}`,
      );
      hub.broadcast({ type: "message", message });
    },
    onNewChat: () => {
      hub.broadcast({ type: "chats-updated", chats: listKnownChats() });
    },
    onChatRemoved: () => {
      hub.broadcast({ type: "chats-updated", chats: listKnownChats() });
    },
    onError: (err) =>
      console.error(
        "[QuickReply] poller error:",
        err instanceof Error ? err.message : String(err),
      ),
  });
}
