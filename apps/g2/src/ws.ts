// WebSocket client for the G2 app.
// The app sends JSON control messages as text over the page's socket
// (via sendToServer in main.ts) and receives transcripts, receipts and
// errors back. There are no PCM helpers here: on real hardware the mic
// stream comes from bridge.audioControl, and in the simulator the audio
// arrives from the injection harness on a separate socket.
// The old sendPcmFrames / sendAudioEnd / sendTranscriptText helpers were
// deleted — dead exports, and the last two were broken: they omitted
// messageId, which the server requires.

export const FRAME_BYTES = 3200;

export function connectWs(url: string): WebSocket {
  return new WebSocket(url);
}
