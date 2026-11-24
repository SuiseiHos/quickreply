import { test, expect } from "vitest";
import { WebSocket } from "ws";
import { createServer } from "./index.js";

async function boot() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server has no address");
  }
  return { server, port: address.port };
}

async function shutdown(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("GET /health returns {ok:true}", async () => {
  const { server, port } = await boot();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  } finally {
    await shutdown(server);
  }
});

test("WS echoes a text frame verbatim", async () => {
  const { server, port } = await boot();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    const echoed = await new Promise<string>((resolve) => {
      ws.on("message", (data) => resolve(String(data)));
      ws.send("hello");
    });
    expect(echoed).toBe("hello");
    ws.close();
  } finally {
    await shutdown(server);
  }
});
