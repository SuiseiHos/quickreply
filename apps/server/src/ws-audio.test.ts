// WS audio handler tests (Task 5): PCM frames → transcript broadcast,
// with the transcriber faked (the real one is covered by whisper.test.ts).
// Two sockets: the harness (sends audio) and the glasses (receives the
// broadcast transcript) — the CallIt split-socket shape.
import { beforeEach, test, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createServer, createHub } from "./index.js";
import {
  saveMessage,
  __clearAllForTests,
  type IncomingMessage,
} from "./message-store.js";

process.env.QUICKREPLY_DB_PATH = join(
  tmpdir(),
  `quickreply-wsaudio-test-${process.pid}.db`,
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

async function boot(transcribe: (pcm: Buffer) => Promise<string>) {
  const hub = createHub();
  const server = createServer(hub, { transcribe });
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

test("audio-end transcribes and broadcasts the transcript to all clients", async () => {
  saveMessage(FIXTURE);
  const seen: { pcm: Buffer | null } = { pcm: null };
  const { server, port } = await boot(async (pcm) => {
    seen.pcm = pcm;
    return "On my way, see you soon.";
  });
  try {
    const glasses = await connect(port);
    const harness = await connect(port);
    try {
      const onGlasses = nextMessage(glasses);
      harness.send(Buffer.from([1, 2, 3, 4]));
      harness.send(Buffer.from([5, 6, 7, 8]));
      harness.send(JSON.stringify({ type: "audio-end", messageId: "-123:7" }));
      const msg = await onGlasses;
      expect(msg).toEqual({
        type: "transcript",
        messageId: "-123:7",
        chatTitle: "Ops",
        text: "On my way, see you soon.",
      });
      expect(seen.pcm?.length).toBe(8);
    } finally {
      glasses.close();
      harness.close();
    }
  } finally {
    await shutdown(server);
  }
});

test("audio-end for an unknown message returns an unknown-chat error", async () => {
  const { server, port } = await boot(async () => "hello");
  try {
    const harness = await connect(port);
    try {
      const reply = nextMessage(harness);
      harness.send(JSON.stringify({ type: "audio-end", messageId: "-123:999" }));
      const msg = await reply;
      expect(msg.type).toBe("error");
      expect(msg.code).toBe("unknown-chat");
    } finally {
      harness.close();
    }
  } finally {
    await shutdown(server);
  }
});

test("empty transcript broadcasts an empty error with the messageId", async () => {
  saveMessage(FIXTURE);
  const { server, port } = await boot(async () => "   ");
  try {
    const harness = await connect(port);
    try {
      const reply = nextMessage(harness);
      harness.send(Buffer.from([1, 2, 3, 4]));
      harness.send(JSON.stringify({ type: "audio-end", messageId: "-123:7" }));
      const msg = await reply;
      expect(msg.type).toBe("error");
      expect(msg.code).toBe("empty");
      expect(msg.messageId).toBe("-123:7");
    } finally {
      harness.close();
    }
  } finally {
    await shutdown(server);
  }
});

test("transcriber failure broadcasts an stt-failed error with the messageId", async () => {
  saveMessage(FIXTURE);
  const { server, port } = await boot(async () => {
    throw new Error("model blew up");
  });
  try {
    const harness = await connect(port);
    try {
      const reply = nextMessage(harness);
      harness.send(Buffer.from([1, 2, 3, 4]));
      harness.send(JSON.stringify({ type: "audio-end", messageId: "-123:7" }));
      const msg = await reply;
      expect(msg.type).toBe("error");
      expect(msg.code).toBe("stt-failed");
      expect(msg.messageId).toBe("-123:7");
    } finally {
      harness.close();
    }
  } finally {
    await shutdown(server);
  }
});

test("transcript-text broadcasts the typed transcript (test seam)", async () => {
  saveMessage(FIXTURE);
  const { server, port } = await boot(async () => "unused");
  try {
    const glasses = await connect(port);
    const harness = await connect(port);
    try {
      const onGlasses = nextMessage(glasses);
      harness.send(
        JSON.stringify({
          type: "transcript-text",
          messageId: "-123:7",
          text: "Typed reply here.",
        }),
      );
      const msg = await onGlasses;
      expect(msg).toEqual({
        type: "transcript",
        messageId: "-123:7",
        chatTitle: "Ops",
        text: "Typed reply here.",
      });
    } finally {
      glasses.close();
      harness.close();
    }
  } finally {
    await shutdown(server);
  }
});

// --- Task 6: the silence gate (Whisper hallucinates on silence —
// FRICTION.md, T5). Near-silent audio returns `empty` WITHOUT calling
// the transcriber. ---

test("near-silent audio returns empty and never calls the transcriber", async () => {
  saveMessage(FIXTURE);
  let calls = 0;
  const { server, port } = await boot(async () => {
    calls++;
    return "should not be called";
  });
  try {
    const harness = await connect(port);
    try {
      const reply = nextMessage(harness);
      // 1 s of digital silence: every sample is 0.
      harness.send(Buffer.alloc(32000));
      harness.send(JSON.stringify({ type: "audio-end", messageId: "-123:7" }));
      const msg = await reply;
      expect(msg.type).toBe("error");
      expect(msg.code).toBe("empty");
      expect(msg.messageId).toBe("-123:7");
      expect(calls).toBe(0);
    } finally {
      harness.close();
    }
  } finally {
    await shutdown(server);
  }
});

test("audible audio still reaches the transcriber", async () => {
  saveMessage(FIXTURE);
  let calls = 0;
  const { server, port } = await boot(async () => {
    calls++;
    return "heard you";
  });
  try {
    const harness = await connect(port);
    const glasses = await connect(port);
    try {
      const onGlasses = nextMessage(glasses);
      // A loud-enough frame: samples at half full scale.
      const loud = Buffer.alloc(3200);
      for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(16000, i);
      harness.send(loud);
      harness.send(JSON.stringify({ type: "audio-end", messageId: "-123:7" }));
      const msg = await onGlasses;
      expect(msg.type).toBe("transcript");
      expect(msg.text).toBe("heard you");
      expect(calls).toBe(1);
    } finally {
      harness.close();
      glasses.close();
    }
  } finally {
    await shutdown(server);
  }
});
