import { beforeEach, test, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createServer, createHub } from "./index.js";
import {
  saveMessage,
  listInbox,
  __clearAllForTests,
  type IncomingMessage,
} from "./message-store.js";

process.env.QUICKREPLY_DB_PATH = join(
  tmpdir(),
  `quickreply-index-test-${process.pid}.db`,
);

const FIXTURE: IncomingMessage = {
  id: "-123:7",
  update_id: 1001,
  chat_id: -123,
  chat_title: "Ops",
  sender_name: "Ani",
  text: "hello from the group",
  created_at: new Date(1795524000 * 1000).toISOString(),
};

beforeEach(() => {
  __clearAllForTests();
});

async function boot(hub = createHub()) {
  const server = createServer(hub);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server has no address");
  }
  return { hub, server, port: address.port };
}

async function shutdown(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  return ws;
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (data) =>
      resolve(JSON.parse(String(data)) as Record<string, unknown>),
    );
  });
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

test("WS list-inbox returns the stored messages", async () => {
  saveMessage(FIXTURE);
  const { server, port } = await boot();
  try {
    const ws = await connect(port);
    try {
      const reply = nextMessage(ws);
      ws.send(JSON.stringify({ type: "list-inbox" }));
      const msg = await reply;
      expect(msg.type).toBe("inbox");
      const messages = msg.messages as Record<string, unknown>[];
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: "-123:7",
        text: "hello from the group",
      });
      expect(msg.replies).toEqual([
        "On my way",
        "Noted, will check",
        "Can't talk now",
        "Yes",
        "No",
      ]);
    } finally {
      ws.close();
    }
  } finally {
    await shutdown(server);
  }
});

test("WS broadcast pushes a new message to connected clients", async () => {
  const { hub, server, port } = await boot();
  try {
    const ws = await connect(port);
    try {
      const pushed = nextMessage(ws);
      hub.broadcast({ type: "message", message: FIXTURE });
      const msg = await pushed;
      expect(msg.type).toBe("message");
      expect(
        (msg.message as Record<string, unknown>).id,
      ).toBe("-123:7");
    } finally {
      ws.close();
    }
  } finally {
    await shutdown(server);
  }
});

test("WS open-message marks the message read and returns it", async () => {
  saveMessage(FIXTURE);
  const { server, port } = await boot();
  try {
    const ws = await connect(port);
    try {
      const reply = nextMessage(ws);
      ws.send(JSON.stringify({ type: "open-message", messageId: "-123:7" }));
      const msg = await reply;
      expect(msg.type).toBe("message");
      expect((msg.message as Record<string, unknown>).id).toBe("-123:7");
      expect(listInbox()[0].read).toBe(1);
    } finally {
      ws.close();
    }
  } finally {
    await shutdown(server);
  }
});

test("WS update-replies saves 5 replies and broadcasts replies-updated", async () => {
  const { server, port } = await boot();
  try {
    const ws = await connect(port);
    try {
      const pushed = nextMessage(ws);
      ws.send(
        JSON.stringify({
          type: "update-replies",
          replies: ["Got it", "On it", "Later", "OK", "Nope"],
        }),
      );
      const msg = await pushed;
      expect(msg.type).toBe("replies-updated");
      expect(msg.replies).toEqual(["Got it", "On it", "Later", "OK", "Nope"]);
    } finally {
      ws.close();
    }
  } finally {
    await shutdown(server);
  }
});

test("WS update-replies rejects an over-long reply with an error", async () => {
  const { server, port } = await boot();
  try {
    const ws = await connect(port);
    try {
      const reply = nextMessage(ws);
      ws.send(
        JSON.stringify({
          type: "update-replies",
          replies: ["a", "b", "c", "d", "x".repeat(65)],
        }),
      );
      const msg = await reply;
      expect(msg.type).toBe("error");
      expect(msg.code).toBe("bad-replies");
    } finally {
      ws.close();
    }
  } finally {
    await shutdown(server);
  }
});

test("WS send-canned returns a receipt and calls Telegram once", async () => {
  saveMessage(FIXTURE);
  const calls: { chatId: number; text: string }[] = [];
  const hub = createHub({
    sendTelegram: async (chatId, text) => {
      calls.push({ chatId, text });
      return { message_id: 99, chat: { id: chatId }, date: 1795524000, text };
    },
  });
  const { server, port } = await boot(hub);
  try {
    const ws = await connect(port);
    try {
      const reply = nextMessage(ws);
      ws.send(
        JSON.stringify({
          type: "send-canned",
          messageId: "-123:7",
          slot: 0,
          idempotencyKey: "ws-key-1",
        }),
      );
      const msg = await reply;
      expect(msg.type).toBe("receipt");
      expect(msg.messageId).toBe("-123:7");
      expect(msg.chatTitle).toBe("Ops");
      expect(msg.text).toBe("On my way");
      expect(typeof msg.sentAt).toBe("string");
      expect(calls).toEqual([{ chatId: -123, text: "On my way" }]);
    } finally {
      ws.close();
    }
  } finally {
    await shutdown(server);
  }
});

test("WS send-canned re-send with the same key returns the stored receipt", async () => {
  saveMessage(FIXTURE);
  const calls: { chatId: number; text: string }[] = [];
  const hub = createHub({
    sendTelegram: async (chatId, text) => {
      calls.push({ chatId, text });
      return { message_id: 99, chat: { id: chatId }, date: 1795524000, text };
    },
  });
  const { server, port } = await boot(hub);
  try {
    const ws = await connect(port);
    try {
      const first = nextMessage(ws);
      ws.send(
        JSON.stringify({
          type: "send-canned",
          messageId: "-123:7",
          slot: 0,
          idempotencyKey: "ws-key-2",
        }),
      );
      const receipt1 = await first;
      const second = nextMessage(ws);
      ws.send(
        JSON.stringify({
          type: "send-canned",
          messageId: "-123:7",
          slot: 0,
          idempotencyKey: "ws-key-2",
        }),
      );
      const receipt2 = await second;
      expect(receipt2).toEqual(receipt1);
      expect(calls).toHaveLength(1);
    } finally {
      ws.close();
    }
  } finally {
    await shutdown(server);
  }
});

test("WS send-canned for an unknown message returns an error", async () => {
  const { server, port } = await boot();
  try {
    const ws = await connect(port);
    try {
      const reply = nextMessage(ws);
      ws.send(
        JSON.stringify({
          type: "send-canned",
          messageId: "-123:999",
          slot: 0,
          idempotencyKey: "ws-key-3",
        }),
      );
      const msg = await reply;
      expect(msg.type).toBe("error");
      expect(msg.code).toBe("unknown-chat");
    } finally {
      ws.close();
    }
  } finally {
    await shutdown(server);
  }
});
