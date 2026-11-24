#!/usr/bin/env python3
"""Local Whisper STT for the QuickReply server (Task 4).

Reads a raw 16 kHz mono s16le PCM file, transcribes it with faster-whisper
(small.en, int8) and prints {"text": "..."} as a single JSON line on stdout.
Errors go to stderr with a non-zero exit code.

Raw PCM (not WAV): the server already holds PCM, and passing a numpy array
skips faster-whisper's PyAV decoder, which is version-fragile (av 19
dropped the metadata_errors argument faster-whisper 1.2.1 passes).

Why local: the app is no-AI by design (DEEP-DIVE §2) — transcription runs
on-device with faster-whisper, no API key, nothing to leak.
"""
import json
import os
import sys

MODEL = os.environ.get("STT_MODEL", "small.en")
COMPUTE_TYPE = "int8"


def read_pcm_16k(path: str):
    """Read raw 16 kHz mono s16le PCM into a float32 numpy array."""
    import numpy as np

    with open(path, "rb") as f:
        frames = f.read()
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: transcribe.py <file.pcm>", file=sys.stderr)
        return 2
    from faster_whisper import WhisperModel

    model = WhisperModel(MODEL, device="cpu", compute_type=COMPUTE_TYPE)
    audio = read_pcm_16k(sys.argv[1])
    segments, _info = model.transcribe(audio, language="en", beam_size=5)
    text = " ".join(s.text.strip() for s in segments).strip()
    print(json.dumps({"text": text}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
