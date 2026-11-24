// Whisper STT test (Task 5): the real local transcriber on the fixture
// reply. One test only — the model loads fresh on every call (~10 s on
// this CPU), so the suite must not transcribe on every run. The exact
// text is asserted: the same model + same audio is deterministic.
import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { transcribePcm } from "./whisper.js";
import { extractPcm } from "./wav.js";

const FIXTURE_WAV = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "test",
  "fixtures",
  "reply.wav",
);

test(
  "transcribePcm transcribes the fixture reply",
  async () => {
    const pcm = extractPcm(readFileSync(FIXTURE_WAV));
    const text = await transcribePcm(pcm);
    expect(text).toBe("On my way, I'll be there in five minutes.");
  },
  120_000,
);
