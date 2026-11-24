# QuickReply — Claims and Evidence

Every claim below is backed by a test run, a live Telegram message, or a
screenshot Sui read herself. Nothing here is a builder's assertion.

## Tests (24 Nov 2026, ~20:40 WIB)

- `npx vitest run` → **67/67 passed** (7 files). Includes one real
  faster-whisper transcription of the Piper fixture (small.en, exact text).
- `npx tsx apps/server/scripts/smoke-test.ts` → **9/9 steps passed**,
  exit 0: boot → inbox → open → canned send → idempotent re-send →
  transcript → voice send → phone edit → silence gate.

## Live Telegram sends (bot @quickreply_g2_bot, group "suisei/ dan QuickReply" + DM)

| # | Text | Mode | Telegram message_id | When (WIB) |
|---|------|------|--------------------|------------|
| 1 | On my way | C2 canned, sim | 4 | 24 Nov 20:12 |
| 2 | Noted, will check | C2 canned, WS script (idempotency) | 5 | 24 Nov 20:14 |
| 3 | Can't talk now | C2 canned, sim | 6 | 24 Nov 20:14 |
| 4 | On my way, I'll be there in five minutes. | C1 voice, sim + WAV injection | 7 | 24 Nov 20:30 |
| 5 | On my way, I'll be there in five minutes. | C1 voice, sim + WAV injection (T6 build) | 8 | 24 Nov 20:36 |

Idempotency: the same key sent twice returned the identical stored
receipt with exactly one Telegram call and one `send_keys` row.

## Live simulator screenshots (all 8 screens, T6 build, 24 Nov 20:36 WIB)

`~/workspace/tmp/qr-t6-{home,inbox,message,menu,recording,review,receipt,error}-20261124-20*.png`

1. Home — "QuickReply / Tap = Messages / 1 new / Double-tap = Exit"
2. Inbox — both real chats ("/start" DM unread first, "Halo" group)
3. Message — "Halo" from Alvin, "Tap = Reply Swipe up = Voice"
4. Reply menu — five canned replies, "Swipe = Pick Tap = Send"
5. Recording — "REC / To suisei/ dan QuickReply: / Speak now"
6. Transcript review — "To suisei/ dan QuickReply: / On my way, I'll be
   there in five minutes. / Tap = Send Swipe up = Edit"
7. Receipt — "Sent 20:36 / suisei/ dan QuickReply: On my way, I'll be
   there in five minutes."
8. Error — "Nothing heard — try again / Tap = Retry / Long-press = Back"

## Error states

- **Empty audio** → `Nothing heard — try again` (verified live, T5 + T6).
  A silence gate (peak sample < 50) now answers `empty` without loading
  Whisper at all — Whisper hallucinated "You" from 1 s of digital
  silence (FRICTION.md).
- **STT failure** → `Couldn't hear that. Tap to try again.` (verified
  live in T5 when a build bug dropped `transcribe.py` from `dist/`; the
  bug is fixed — the build now copies the file).
- **Clobber regression** → a transcript for the DM left the group
  review byte-identical (verified live, T5).
- **WS reconnect + server restart mid-demo** → the server was restarted
  while the glasses sat on an error screen; the app reconnected, the
  inbox reloaded from the new server, and the golden path ran to a
  receipt (T6, message_id 8).
- **Send-failed retry** → unit-tested only (a fake Telegram sender that
  throws; the error screen retries with the same idempotency key). No
  live trigger exists without breaking the real Telegram call, so it was
  not forced live.
- **Over-long transcript (>4096 chars)** → unit-tested only (the gate in
  `sendText` and `update-transcript`); a live one needs ~10 minutes of
  speech.

## Early video backup

`~/workspace/goals/even-realities-hackathon-callit-build-and-submission/hidden_files/video/quickreply-backup-20261124.mp4`
— 27 s, 1280×720, title card + the 8 screens, 3 s each, no voiceover.
A safety net only; the T7 demo video replaces it.

## What is NOT claimed

- No real G2 hardware has run this app — only the Even Hub simulator
  (v0.9.5). The mic path (`bridge.audioControl`) is a real-device path
  the simulator cannot exercise; audio arrived via the WAV-injection
  harness on a separate socket.
- No public backend host exists yet (local only, by Alvin's choice).
- The repo has never been pushed; it is local-only until Alvin's go.
