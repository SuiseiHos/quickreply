// WAV-injection harness: feeds a pre-recorded WAV through the
// same WebSocket binary-frame path as live glasses-mic audio.
// The build VM has no microphone, so this is how voice is tested end to
// end. Usage:
//   npx tsx scripts/inject-audio.ts <file.wav> <message-id> [ws://localhost:3000]
// Prints the transcript (or error) the server broadcasts, then exits.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import { extractPcm, FRAME_BYTES, SAMPLE_RATE } from "../src/wav.js";

export { extractPcm, pcmToWav, FRAME_BYTES, SAMPLE_RATE } from "../src/wav.js";

/**
 * Send PCM to the backend at the live-mic cadence (one 100 ms frame per
 * tick), then audio-end for the message, and wait for the transcript (or
 * error) the server broadcasts. Resolves with the first transcript/error
 * for that message.
 */
export async function injectWav(
  file: string,
  messageId: string,
  url: string,
): Promise<Record<string, unknown>> {
  const pcm = extractPcm(readFileSync(file));
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  console.log(
    `injecting ${pcm.length} bytes (${(pcm.length / 2 / SAMPLE_RATE).toFixed(2)}s) to ${url} for ${messageId}`,
  );
  const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("no transcript within 60 s")),
      60_000,
    );
    ws.on("message", (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (typeof msg !== "object" || msg === null) return;
      const type = (msg as { type?: unknown }).type;
      const mid = (msg as { messageId?: unknown }).messageId;
      if (type === "transcript" && mid === messageId) {
        clearTimeout(timer);
        resolve(msg as Record<string, unknown>);
      } else if (type === "error" && mid === messageId) {
        clearTimeout(timer);
        resolve(msg as Record<string, unknown>);
      }
    });
  });
  let offset = 0;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (offset >= pcm.length) {
        clearInterval(timer);
        ws.send(JSON.stringify({ type: "audio-end", messageId }));
        resolve();
        return;
      }
      ws.send(pcm.subarray(offset, offset + FRAME_BYTES));
      offset += FRAME_BYTES;
    }, 100);
  });
  const result = await reply;
  ws.close();
  return result;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [file, messageId, url = "ws://localhost:3000"] = process.argv.slice(2);
  if (!file || !messageId) {
    console.error(
      "usage: npx tsx scripts/inject-audio.ts <file.wav> <message-id> [ws-url]",
    );
    process.exit(2);
  }
  injectWav(file, messageId, url)
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
