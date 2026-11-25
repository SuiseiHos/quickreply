// Smoke test: one command that boots the real server and drives
// the whole golden path over a real WebSocket — inbox → open → canned
// send → voice transcript → voice send → phone edit — plus the silence
// gate. Telegram and Whisper are faked at the boundary (no real message
// leaves this machine, no model loads); everything else is the production
// wiring. Usage: npx tsx scripts/smoke-test.ts — exits 0 when every step
// passes, 1 otherwise.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { WebSocket } from "ws";
import { createServer, createHub } from "../src/index.js";
import {
  saveMessage,
  getSend,
  recordKnownChat,
  type IncomingMessage,
} from "../src/message-store.js";

process.env.QUICKREPLY_DB_PATH = join(
  tmpdir(),
  `quickreply-smoke-${process.pid}.db`,
);

const FIXTURE: IncomingMessage = {
  id: "-123:7",
  update_id: 1001,
  chat_id: -123,
  chat_title: "Ops",
  sender_id: 555,
  sender_name: "Ani",
  text: "hello from the group",
  created_at: new Date(1795524000 * 1000).toISOString(),
};

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<number> {
  const calls: { chatId: number; text: string }[] = [];
  const hub = createHub({
    sendTelegram: async (chatId, text) => {
      calls.push({ chatId, text });
      return { message_id: 99, chat: { id: chatId }, date: 1795524000, text };
    },
  });
  const server = createServer(hub, {
    transcribe: async () => "Smoke test reply.",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server has no address");
  }
  const port = address.port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  const queue: Record<string, unknown>[] = [];
  ws.on("message", (data) => {
    try {
      queue.push(JSON.parse(String(data)) as Record<string, unknown>);
    } catch {
      // Ignore non-JSON frames.
    }
  });
  async function next(timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const start = Date.now();
    for (;;) {
      const msg = queue.shift();
      if (msg) return msg;
      if (Date.now() - start > timeoutMs) {
        throw new Error("timed out waiting for a server message");
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  try {
    saveMessage(FIXTURE);
    // The poller records the chat as known when a message arrives;
    // the fixture bypasses the poller, so record it the same way.
    recordKnownChat(-123, "Ops");

    // 1. list-inbox returns the fixture + the 5 default replies.
    ws.send(JSON.stringify({ type: "list-inbox" }));
    const inbox = await next();
    check(
      "list-inbox returns the fixture message",
      inbox.type === "inbox" &&
        Array.isArray(inbox.messages) &&
        inbox.messages.length === 1 &&
        (inbox.messages[0] as Record<string, unknown>).id === "-123:7" &&
        Array.isArray(inbox.replies) &&
        inbox.replies.length === 5,
    );

    // 2. open-message returns the message.
    ws.send(JSON.stringify({ type: "open-message", messageId: "-123:7" }));
    const opened = await next();
    check(
      "open-message returns the message",
      opened.type === "message" &&
        (opened.message as Record<string, unknown>).id === "-123:7",
    );

    // 3. C2 send: receipt + the fake's message_id recorded.
    ws.send(
      JSON.stringify({
        type: "send-canned",
        messageId: "-123:7",
        slot: 0,
        idempotencyKey: "smoke-1",
      }),
    );
    const receipt1 = await next();
    check(
      "send-canned returns a receipt for slot 0",
      receipt1.type === "receipt" &&
        receipt1.text === "On my way" &&
        receipt1.chatTitle === "Ops" &&
        typeof receipt1.sentAt === "string",
    );
    check(
      "send-canned recorded message_id 99",
      getSend("smoke-1")?.message_id === 99 &&
        calls.length === 1 &&
        calls[0].text === "On my way",
    );

    // 4. Same key again: identical receipt, no second Telegram call.
    ws.send(
      JSON.stringify({
        type: "send-canned",
        messageId: "-123:7",
        slot: 0,
        idempotencyKey: "smoke-1",
      }),
    );
    const receipt2 = await next();
    check(
      "re-send with the same key returns the stored receipt",
      JSON.stringify(receipt2) === JSON.stringify(receipt1) &&
        calls.length === 1,
    );

    // 5. Voice: loud PCM + audio-end → the transcript broadcast.
    const loud = Buffer.alloc(3200);
    for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(16000, i);
    ws.send(loud);
    ws.send(JSON.stringify({ type: "audio-end", messageId: "-123:7" }));
    const transcript = await next();
    check(
      "audio-end returns the transcript for the message",
      transcript.type === "transcript" &&
        transcript.messageId === "-123:7" &&
        transcript.text === "Smoke test reply.",
    );

    // 6. Voice send: the transcript goes out through the same gate.
    ws.send(
      JSON.stringify({
        type: "send-voice",
        messageId: "-123:7",
        text: "Smoke test reply.",
        idempotencyKey: "smoke-2",
      }),
    );
    const receipt3 = await next();
    check(
      "send-voice returns a receipt",
      receipt3.type === "receipt" &&
        receipt3.text === "Smoke test reply." &&
        calls.length === 2,
    );

    // 7. Phone edit: the edited transcript broadcasts back.
    ws.send(
      JSON.stringify({
        type: "update-transcript",
        messageId: "-123:7",
        text: "Edited smoke reply.",
      }),
    );
    const edited = await next();
    check(
      "update-transcript broadcasts the edited text",
      edited.type === "transcript" &&
        edited.messageId === "-123:7" &&
        edited.text === "Edited smoke reply.",
    );

    // 8. Silence gate: zero audio → `empty`, no transcription.
    ws.send(Buffer.alloc(32000));
    ws.send(JSON.stringify({ type: "audio-end", messageId: "-123:7" }));
    const empty = await next();
    check(
      "silent audio returns an empty error",
      empty.type === "error" &&
        empty.code === "empty" &&
        empty.messageId === "-123:7",
    );

    // 9. Per-chat replies: a custom set for Ops, then a canned send
    // uses the chat's text, not the global one.
    ws.send(
      JSON.stringify({
        type: "set-chat-replies",
        chat_id: -123,
        replies: ["On it", "In a meeting", "Will check", "Yes", "No"],
      }),
    );
    const chatRepliesUpdated = await next();
    check(
      "set-chat-replies broadcasts chat-replies-updated",
      chatRepliesUpdated.type === "chat-replies-updated" &&
        chatRepliesUpdated.chat_id === -123 &&
        Array.isArray(chatRepliesUpdated.replies) &&
        (chatRepliesUpdated.replies as string[])[0] === "On it",
    );
    ws.send(
      JSON.stringify({
        type: "send-canned",
        messageId: "-123:7",
        slot: 0,
        idempotencyKey: "smoke-3",
      }),
    );
    const receipt4 = await next();
    check(
      "send-canned with a custom set sends the chat's text",
      receipt4.type === "receipt" &&
        receipt4.text === "On it" &&
        calls.length === 3 &&
        calls[2].text === "On it",
    );
  } catch (err) {
    check("smoke test ran to completion", false, String(err));
  } finally {
    ws.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} steps passed`,
  );
  try {
    unlinkSync(process.env.QUICKREPLY_DB_PATH);
  } catch {
    // The temp DB is best-effort cleanup.
  }
  return failed.length === 0 ? 0 : 1;
}

process.exitCode = await main();
