// WebSocket audio upload handler. No LLM: the transcript goes
// straight to the glasses for the deterministic pre-send review.
// Accumulates binary PCM frames per connection; on "audio-end" replies
// with the transcript. The glasses and the injection harness are separate
// sockets, so the transcript AND the voice errors are BROADCAST to all
// clients — the glasses apply them only when they are recording or
// reviewing that same message (the clobber guard lives in main.ts).
// {type:"transcript-text"} is the typed-transcript test seam: it skips
// audio and sends text straight through the same broadcast, and it only
// works when QUICKREPLY_ALLOW_TRANSCRIPT_TEXT=1.
import type { WebSocket } from "ws";
import { transcribePcm } from "./whisper.js";
import { getMessage } from "./message-store.js";

/** The shape a transcriber must satisfy; injectable so tests can use a
 * fake instead of loading the Whisper model. */
export type TranscribeFn = (pcm: Buffer) => Promise<string>;

/** Peak absolute sample of 16 kHz mono s16le PCM (0 for empty input). */
export function maxAbsSample(pcm: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak;
}

/** PCM cap: 10 minutes of 16 kHz mono s16le (~19 MB). A recording past
 * it is rejected as `too-long` without loading the model. */
export const MAX_PCM_BYTES = 16000 * 2 * 600;

export function createAudioHandler(opts: {
  broadcast: (msg: unknown) => void;
  transcribe?: TranscribeFn;
  /** Test seam: a smaller cap so the rejection is reachable in a test. */
  maxPcmBytes?: number;
}) {
  const transcribe = opts.transcribe ?? transcribePcm;
  const maxPcmBytes = opts.maxPcmBytes ?? MAX_PCM_BYTES;
  const sessions = new Map<WebSocket, { chunks: Buffer[]; bytes: number }>();

  /** A binary PCM frame from one connection. Frames past the cap are
   * dropped, so a stuck recording cannot grow memory without bound. */
  function onBinary(ws: WebSocket, data: Buffer): void {
    const session = sessions.get(ws) ?? { chunks: [], bytes: 0 };
    if (session.bytes < maxPcmBytes) {
      session.chunks.push(data);
      session.bytes += data.length;
    }
    sessions.set(ws, session);
  }

  /** Discard the buffered PCM for one connection (user cancelled). */
  function onDiscard(ws: WebSocket): void {
    sessions.set(ws, { chunks: [], bytes: 0 });
  }

  async function onAudioEnd(ws: WebSocket, messageId: string): Promise<void> {
    const message = getMessage(messageId);
    if (!message) {
      ws.send(JSON.stringify({ type: "error", code: "unknown-chat" }));
      return;
    }
    const session = sessions.get(ws) ?? { chunks: [], bytes: 0 };
    sessions.set(ws, { chunks: [], bytes: 0 });
    const pcm = Buffer.concat(session.chunks);
    console.log(
      `[QuickReply] audio-end for ${messageId}: ${pcm.length} bytes`,
    );
    // Over-cap recording: reject before the silence gate or
    // the model ever sees it.
    if (session.bytes >= maxPcmBytes) {
      opts.broadcast({ type: "error", code: "too-long", messageId });
      return;
    }
    // Silence gate: Whisper hallucinates on near-silence (it
    // transcribed 1 s of digital silence as "You").
    // Below this peak the audio carries no speech, so answer `empty`
    // without loading the model. The fixture reply peaks at 32080; even
    // quiet speech peaks in the hundreds, so 50 is far from any real voice.
    if (maxAbsSample(pcm) < 50) {
      opts.broadcast({ type: "error", code: "empty", messageId });
      return;
    }
    let text: string;
    try {
      text = await transcribe(pcm);
    } catch (err) {
      console.error("[QuickReply] stt failed:", err);
      opts.broadcast({
        type: "error",
        code: "stt-failed",
        messageId,
      });
      return;
    }
    if (!text.trim()) {
      opts.broadcast({ type: "error", code: "empty", messageId });
      return;
    }
    opts.broadcast({
      type: "transcript",
      messageId,
      chatTitle: message.chat_title,
      text: text.trim(),
    });
  }

  function onTranscriptText(
    _ws: WebSocket,
    messageId: string,
    text: string,
  ): void {
    const message = getMessage(messageId);
    if (!message) {
      _ws.send(JSON.stringify({ type: "error", code: "unknown-chat" }));
      return;
    }
    if (!text.trim()) {
      _ws.send(JSON.stringify({ type: "error", code: "bad-message" }));
      return;
    }
    opts.broadcast({
      type: "transcript",
      messageId,
      chatTitle: message.chat_title,
      text: text.trim(),
    });
  }

  /** A text message that belongs to the audio path. Returns true when the
   * message was handled here (so the hub must not see it). */
  function onText(ws: WebSocket, msg: unknown): boolean {
    if (typeof msg !== "object" || msg === null) return false;
    const type = (msg as { type?: unknown }).type;
    if (type === "audio-end") {
      const messageId = (msg as { messageId?: unknown }).messageId;
      if (typeof messageId !== "string") {
        ws.send(JSON.stringify({ type: "error", code: "bad-message" }));
        return true;
      }
      void onAudioEnd(ws, messageId);
      return true;
    }
    if (type === "audio-discard") {
      onDiscard(ws);
      return true;
    }
    if (type === "transcript-text") {
      // Test seam: typed transcripts are accepted ONLY when
      // the flag is set — never on a production server, where any local
      // client could otherwise forge a transcript and bypass STT and the
      // silence gate. When the flag is off, the message is not an audio
      // message at all (the hub ignores it as an unknown type).
      if (process.env.QUICKREPLY_ALLOW_TRANSCRIPT_TEXT !== "1") return false;
      const messageId = (msg as { messageId?: unknown }).messageId;
      const text = (msg as { text?: unknown }).text;
      if (typeof messageId !== "string" || typeof text !== "string") {
        ws.send(JSON.stringify({ type: "error", code: "bad-message" }));
        return true;
      }
      onTranscriptText(ws, messageId, text);
      return true;
    }
    return false;
  }

  function onClose(ws: WebSocket): void {
    sessions.delete(ws);
  }

  return { onBinary, onText, onClose };
}

export type AudioHandler = ReturnType<typeof createAudioHandler>;
