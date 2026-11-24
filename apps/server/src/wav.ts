// WAV helpers: 16 kHz mono s16le PCM <-> RIFF/WAVE. Shared by
// the injection harness and the Whisper test.
export const SAMPLE_RATE = 16000;
export const FRAME_BYTES = 3200; // 100 ms of 16 kHz mono s16le audio

/** Wrap 16 kHz mono s16le PCM in a 44-byte RIFF/WAVE header. */
export function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4); // chunk size
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24); // sample rate
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40); // data size
  return Buffer.concat([header, pcm]);
}

/** Strip a WAV file down to its raw PCM data chunk. */
export function extractPcm(wav: Buffer): Buffer {
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") return wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  throw new Error("WAV has no data chunk");
}
