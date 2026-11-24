// QuickReply backend: Express + WebSocket on one port (Task 1).
// Walking skeleton: /health + verbatim WS echo. Task 2 replaces the echo
// with the Telegram inbox router. No secret is needed to boot.
import express from "express";
import { createServer as createHttpServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 3000);

export function createServer() {
  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  const server = createHttpServer(app);
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    // T1 echo contract: verbatim text-frame echo. Replaced in Task 2.
    ws.on("message", (data) => ws.send(data));
  });
  return server;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`QuickReply server listening on :${PORT}`);
  });
}
