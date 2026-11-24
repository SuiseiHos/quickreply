# QuickReply

**Reply to Telegram from your Even G2 glasses. Three taps from the inbox — or speak one, and the glasses send exactly what you said. No AI in the loop.**

![QuickReply demo — the eight glasses screens](demo.gif)

A message lands in a Telegram group. The glasses show it. Tap to open, tap to pick a reply (`On my way`, `Noted, will check`, `Can't talk now`, `Yes`, `No`), tap to send — and the reply is in Telegram, with a receipt on the glass. Or swipe up, speak the reply, check the transcript on the glass, and tap to send. The voice is transcribed on the device by local Whisper; nothing leaves the device except the message you chose to send.

Built for the [Even Realities hackathon](https://dorahacks.io/hackathon/even-realities/detail) (DoraHacks, 23–29 Nov 2026), **Track 01 — Messaging & News**.

## What it does

- **C2 — canned replies.** Five replies you edit from the phone panel. Three taps from the inbox to a sent message (open → pick → send), with a `Sent HH:MM` receipt.
- **C1 — voice replies.** Speak on the glasses mic; local faster-whisper (small.en) transcribes on the backend; the glasses show the transcript for review (`To <chat>:` + text) before anything is sent. Tap sends, swipe up edits on the phone, swipe down discards.
- **A real write, not a read-only demo.** Every send is a real `sendMessage` to a real Telegram group, delivered through the Telegram Bot API. The demo sent 9 real messages to real Telegram chats.

- **Long messages page.** A message longer than 3 lines pages on the glasses — swipe down to read on, swipe up to go back; the footer always says which gesture does what.
- **A gate, not a guess.** Every send passes the same server-enforced gate: non-empty after trim (G1), at most 4096 characters — never silently truncated (G2), to a chat the bot has actually seen (G3), once per idempotency key — a double-tap returns the stored receipt and sends nothing twice (G4), and the review always shows `To <chat>:` so you never reply to the wrong chat (G5).
- **Failure is a screen, not a crash.** Empty audio → `Nothing heard — try again`. Transcription failure → `Couldn't hear that. Tap to try again.` A transcript for another message never clobbers the screen you are on (regression-tested live). The server restarts mid-demo and the glasses reconnect on their own.

## Architecture

```
Even G2 glasses (Vite + TS, Even Hub SDK, 576x288)
        |  WebSocket (ws://localhost:3000 in dev,
        |  VITE_SERVER_WS_URL when packaged)
        v
Node + TypeScript backend (Express + ws, SQLite)
   |  getUpdates long-poll in, sendMessage out
   v
Telegram Bot API  (bot @quickreply_g2_bot, privacy mode off)
   |
   +-- local faster-whisper (small.en, int8) for voice replies only
```

- `apps/g2/` — the glasses app: an 8-screen state machine (Home, Inbox, Message, Reply menu, Recording, Transcript review, Receipt, Empty/error) plus the phone panel (reply editor + voice-reply editor + chat allowlist toggles).
- `apps/server/` — the backend: Telegram poller (offset persisted in SQLite, dedupe by `update_id`), the message/reply/send-key stores, the send gate, the Whisper subprocess, and the WebSocket hub. The Telegram token never lives in the server: every Bot API call shells out to a helper (`TELEGRAM_HELPER_PATH`, defaulting to the vaulted-connector helper) that performs the credential exchange per call.
- `apps/server/scripts/smoke-test.ts` — one command that boots the real server and drives the whole golden path over a real WebSocket (9 steps, fakes only at the Telegram/Whisper boundary).

## Setup from a clean checkout

Prerequisites: Node 24+, Python 3.12 with faster-whisper (for voice), a Telegram bot token.

```bash
git clone https://github.com/SuiseiHos/quickreply.git
cd quickreply
npm install
npm run build --workspaces
```

**1. Telegram.** Create a bot with [@BotFather](https://t.me/BotFather), add it to a group (it needs to read group messages — disable privacy mode), and point the server at a Bot API helper: any executable with the CLI `getme`, `getupdates --timeout <s> [--offset N]`, `sendmessage --chat-id <id> --text <text> [--disable-notification]`, each printing `{"ok":true,"result":...}`. Set it with `TELEGRAM_HELPER_PATH=/path/to/helper`. The token must never be committed, logged, or put in an env var the server reads — keep it in the helper.

**2. Voice (optional for the canned-reply path).** Point the server at a Python with faster-whisper: symlink it as `apps/server/.venv` (a `python3 -m venv` + `pip install faster-whisper` works), and set `HF_HOME` to a model cache dir — the first transcription downloads `faster-whisper-small.en` (~500 MB). Without it, canned replies still work; voice returns `Couldn't hear that`.

**3. Run.**

```bash
# terminal 1 — backend on :3000
node apps/server/dist/index.js
# terminal 2 — glasses bundle
cd apps/g2 && npm run dev   # serves the app; load it in the Even Hub simulator
```

**4. Verify without Telegram.** `npx tsx apps/server/scripts/smoke-test.ts` — boots the server on a scratch port and drives inbox → canned send → transcript → voice send → phone edit → silence gate. 9/9 steps, exit 0.

**5. Package for the glasses.** `evenhub pack app.json apps/g2/dist` → `quickreply.ehpk`. The packaged app talks to the backend at `VITE_SERVER_WS_URL` (defaults to `ws://localhost:3000`).

## Known limitations

- **Simulator only.** The app has run on the Even Hub simulator (v0.9.5), not on real G2 hardware. The microphone path (`bridge.audioControl`) is a real-device path the simulator cannot exercise; demo audio arrived through a WAV-injection harness on a separate socket.
- **Local backend.** The demo backend runs on `localhost:3000`; there is no public host yet. `getUpdates` long-polling needs no public URL to receive, but a packaged app on real glasses needs the backend reachable at `VITE_SERVER_WS_URL`.
- **English voice only.** Voice replies transcribe with `small.en`. The canned replies work in any language.
- **Whisper hallucinates on silence.** One second of digital silence transcribed as "You". A silence gate (peak sample < 50) answers `empty` without loading the model, but quiet real speech near the threshold is untested.
- **Send-failed retry and over-long transcripts are unit-tested only.** There is no live trigger for a failed Telegram send without breaking the real call, and a live >4096-character transcript needs ~10 minutes of speech.
- **Chat allowlist (default-deny).** Only chats you approve in the phone panel reach the glasses. A new chat the bot is added to shows as pending — its messages don't reach the glasses — until you check it. A message sent while pending is skipped and never stored. Nothing is ever delivered twice. Chats the bot already served before the allowlist existed were grandfathered in.
- **No remote control.** The bot has no Telegram commands: message text is never executed, and nobody can make the bot do anything from Telegram — the only state-changing inputs are the glasses and the phone panel, over a local WebSocket. The server binds `127.0.0.1` only. (Group admins can still remove or restrict the bot; that is Telegram-side and cannot be prevented in code.)
- **One bot, all chats — now gated.** The inbox shows only allowlisted chats (see above).
