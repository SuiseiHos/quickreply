// WebSocket client for the G2 app (Task 1).
// Binary PCM frames go up (same shape as live mic frames: 3200 bytes =
// 100 ms of 16 kHz mono s16le audio); JSON control messages go up as text;
// transcript / extraction / receipt come down as JSON.

export const FRAME_BYTES = 3200;

export function connectWs(url: string): WebSocket {
  return new WebSocket(url);
}

/** Send PCM in 100 ms frames, the same cadence as live mic frames. */
export function sendPcmFrames(ws: WebSocket, pcm: Uint8Array): void {
  for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
    // Copy into a fresh Uint8Array<ArrayBuffer>: subarray() keeps the
    // ArrayBufferLike type, which TS 7 rejects for WebSocket.send.
    ws.send(new Uint8Array(pcm.subarray(offset, offset + FRAME_BYTES)));
  }
}

/** Signal end of utterance; the server then transcribes + extracts. */
export function sendAudioEnd(ws: WebSocket): void {
  ws.send(JSON.stringify({ type: "audio-end" }));
}

/** Typed-transcript test path: skip audio entirely, send text instead. */
export function sendTranscriptText(ws: WebSocket, text: string): void {
  ws.send(JSON.stringify({ type: "transcript-text", text }));
}
