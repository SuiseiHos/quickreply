// Whisper STT (Task 5) — local faster-whisper via a Python subprocess.
// No AI/LLM and no API key anywhere: DEEP-DIVE §2 specifies local
// faster-whisper (small.en, int8), keyless and on-device. The transcriber
// runs from the repo venv (apps/server/.venv) and reads its model from
// HF_HOME; without HF_HOME it falls back to faster-whisper's default
// cache and downloads the model.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export class SttError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "SttError";
    this.status = status;
  }
}

const TRANSCRIBE_PY = fileURLToPath(new URL("./transcribe.py", import.meta.url));
// NOTE: transcribe.py is a runtime asset, not TypeScript: the build
// script copies it from src/ into dist/ next to this file. If the build
// ever drops that copy, the transcriber fails with "can't open file".
const VENV_PYTHON = fileURLToPath(new URL("../.venv/bin/python3", import.meta.url));
const TRANSCRIBE_TIMEOUT_MS = 120000;

/**
 * Default model cache. On this VM the models already live in the shared
 * cache, so use it when it exists; on a fresh checkout elsewhere, fall
 * back to a repo-local cache (gitignored) and faster-whisper downloads
 * small.en on first use (review F8). HF_HOME always wins when set.
 */
const SHARED_HF_CACHE = "/home/hatch/workspace/tmp/hf-cache";
const LOCAL_HF_CACHE = fileURLToPath(new URL("../.hf-cache", import.meta.url));
export function defaultHfHome(): string {
  return existsSync(SHARED_HF_CACHE) ? SHARED_HF_CACHE : LOCAL_HF_CACHE;
}

/** Transcribe 16 kHz mono s16le PCM; returns the transcript text only. */
export async function transcribePcm(pcm: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "quickreply-stt-"));
  const pcmPath = join(dir, "audio.pcm");
  try {
    await writeFile(pcmPath, pcm);
    return await runTranscriber(pcmPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runTranscriber(pcmPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // The model cache lives at HF_HOME (see DEEP-DIVE §2); the server has
    // no .env, so the child gets the known cache path unless the caller
    // set HF_HOME itself. Without it faster-whisper would re-download
    // small.en into the default cache on first use.
    const child = spawn(VENV_PYTHON, [TRANSCRIBE_PY, pcmPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HF_HOME: process.env.HF_HOME ?? defaultHfHome(),
      },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new SttError("transcriber timed out"));
    }, TRANSCRIBE_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new SttError(`transcriber spawn failed: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new SttError(`transcriber exited ${code}: ${err.trim().slice(-300)}`));
        return;
      }
      try {
        const parsed = JSON.parse(out.trim()) as { text?: unknown };
        if (typeof parsed.text !== "string") throw new Error("no text field");
        resolve(parsed.text);
      } catch (e) {
        reject(new SttError(`bad transcriber output: ${String(e)}`));
      }
    });
  });
}
