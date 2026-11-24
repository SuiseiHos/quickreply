// QuickReply backend: Express + WebSocket on one port (Task 2).
// /health + WS router (list-inbox) + Telegram poller pushing new messages
// to all connected glasses. No secret is needed to boot: the poller calls
// the connector helper, which holds the token in the Vault.
import express from "express";
import { createServer as createHttpServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { listInbox } from "./message-store.js";
import { startPoller } from "./telegram.js";

const PORT = Number(process.env.PORT ?? 3000);

/** Connected glasses + message routing. Kept separate from the HTTP
 * server so tests can drive it over a real WebSocket without a poller. */
export function createHub() {
  const clients = new Set<WebSocket>();
  return {
    addClient(ws: WebSocket) {
      clients.add(ws);
      ws.on("close", () => clients.delete(ws));
    },
    broadcast(msg: unknown) {
      const data = JSON.stringify(msg);
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      }
    },
    handleMessage(ws: WebSocket, raw: string) {
      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (typeof msg !== "object" || msg === null) return;
      if ((msg as { type?: unknown }).type === "list-inbox") {
        ws.send(JSON.stringify({ type: "inbox", messages: listInbox() }));
      }
      // Unknown types are ignored.
    },
  };
}

export type Hub = ReturnType<typeof createHub>;

export function createServer(hub = createHub()) {
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const server = createHttpServer(app);
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    hub.addClient(ws);
    ws.on("message", (data) => hub.handleMessage(ws, String(data)));
  });
  return server;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const hub = createHub();
  const server = createServer(hub);
  server.listen(PORT, () => {
    console.log(`QuickReply server listening on :${PORT}`);
  });
  // Telegram poller: pushes each new message to all connected glasses.
  startPoller({
    onMessage: (message) => {
      console.log(
        `[QuickReply] new message from ${message.chat_title}: ${message.text.slice(0, 60)}`,
      );
      hub.broadcast({ type: "message", message });
    },
    onError: (err) =>
      console.error(
        "[QuickReply] poller error:",
        err instanceof Error ? err.message : String(err),
      ),
  });
}
