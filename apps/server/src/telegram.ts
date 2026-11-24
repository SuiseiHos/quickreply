// Telegram Bot API client (Task 2). The token lives in the registered
// custom.telegram connection and is NEVER in this file, an env var, or a
// log. Every call shells out to the connector helper, which performs the
// surrogate exchange per call (see CONNECTOR.md: the raw-surrogate gotcha).
// Ruling: the server holds no TELEGRAM_BOT_TOKEN — the plan's "Consumes:
// TELEGRAM_BOT_TOKEN env" is superseded by the helper call, because the
// vaulted token cannot be read back into a long-running process.
import { execFile, type ChildProcess } from "node:child_process";
import {
  getOffset,
  saveMessage,
  setOffset,
  type IncomingMessage,
} from "./message-store.js";

const HELPER =
  process.env.TELEGRAM_HELPER_PATH ??
  "/home/hatch/workspace/custom-connectors/custom.telegram/bin/telegram.py";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callHelper(
  args: string[],
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const { stdout } = await new Promise<{
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child: ChildProcess = execFile(
      "python3",
      [HELPER, ...args],
      { timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `telegram helper failed: ${error.message} ${String(stderr).slice(0, 200)}`,
            ),
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
    void child;
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

export type BotIdentity = {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
  can_read_all_group_messages: boolean;
};

/** Live getMe (read-only): proves the token + helper path work. */
export async function getMe(): Promise<{ ok: boolean; result: BotIdentity }> {
  const res = await callHelper(["getme"], 30000);
  if (res.ok !== true) {
    throw new Error(`getMe failed: ${JSON.stringify(res).slice(0, 200)}`);
  }
  return res as unknown as { ok: boolean; result: BotIdentity };
}

/** One long-poll round. Returns the raw updates array. */
export async function fetchUpdates(
  offset: number,
  timeoutSec: number,
): Promise<unknown[]> {
  const args = ["getupdates", "--timeout", String(timeoutSec)];
  if (offset > 0) args.push("--offset", String(offset));
  const res = await callHelper(args, (timeoutSec + 15) * 1000);
  if (res.ok !== true) {
    throw new Error(`getUpdates failed: ${JSON.stringify(res).slice(0, 200)}`);
  }
  if (!Array.isArray(res.result)) {
    throw new Error("getUpdates returned no result array");
  }
  return res.result;
}

/**
 * Converts one raw update into a stored message, or null when it is not a
 * text message from a human sender (edits, photos, bot messages, ...).
 * The id is chat_id:message_id — globally unique and deterministic.
 */
export function parseUpdate(update: unknown): IncomingMessage | null {
  if (typeof update !== "object" || update === null) return null;
  const u = update as { update_id?: unknown; message?: unknown };
  if (typeof u.update_id !== "number") return null;
  const m = u.message as
    | {
        message_id?: unknown;
        date?: unknown;
        chat?: unknown;
        from?: unknown;
        text?: unknown;
      }
    | undefined;
  if (!m || typeof m !== "object") return null;
  if (typeof m.text !== "string" || m.text.length === 0) return null;
  const from = m.from as
    | { first_name?: unknown; last_name?: unknown; is_bot?: unknown }
    | undefined;
  if (from?.is_bot === true) return null;
  const chat = m.chat as { id?: unknown; title?: unknown } | undefined;
  if (!chat || typeof chat.id !== "number") return null;
  if (typeof m.message_id !== "number") return null;
  const senderName =
    [from?.first_name, from?.last_name]
      .filter((part): part is string => typeof part === "string")
      .join(" ") || "Unknown";
  const chatTitle =
    typeof chat.title === "string" ? chat.title : senderName;
  const dateSeconds = typeof m.date === "number" ? m.date : 0;
  return {
    id: `${chat.id}:${m.message_id}`,
    update_id: u.update_id,
    chat_id: chat.id,
    chat_title: chatTitle,
    sender_name: senderName,
    text: m.text,
    created_at: new Date(dateSeconds * 1000).toISOString(),
  };
}

export type PollerOptions = {
  onMessage: (m: IncomingMessage) => void;
  onError?: (err: unknown) => void;
  /** Long-poll timeout per round in seconds (Telegram allows up to 50). */
  pollTimeoutSec?: number;
};

/**
 * Long-poll loop: fetches updates, stores new text messages (dedupe by
 * update_id), advances the persisted offset past every seen update, and
 * calls onMessage for each newly stored message. Never throws: a failed
 * round logs and retries after 5 s. stop() ends the loop and kills an
 * in-flight helper call.
 */
export function startPoller(opts: PollerOptions): { stop: () => void } {
  const pollTimeoutSec = opts.pollTimeoutSec ?? 30;
  let stopped = false;
  let currentChild: ChildProcess | null = null;

  async function fetchOnce(): Promise<unknown[]> {
    const offset = getOffset();
    const args = ["getupdates", "--timeout", String(pollTimeoutSec)];
    if (offset > 0) args.push("--offset", String(offset));
    const stdout = await new Promise<string>((resolve, reject) => {
      currentChild = execFile(
        "python3",
        [HELPER, ...args],
        { timeout: (pollTimeoutSec + 15) * 1000 },
        (error, out, err) => {
          currentChild = null;
          if (error) {
            reject(
              new Error(
                `telegram helper failed: ${error.message} ${String(err).slice(0, 200)}`,
              ),
            );
            return;
          }
          resolve(String(out));
        },
      );
    });
    const res = JSON.parse(stdout) as Record<string, unknown>;
    if (res.ok !== true) {
      throw new Error(
        `getUpdates failed: ${JSON.stringify(res).slice(0, 200)}`,
      );
    }
    if (!Array.isArray(res.result)) {
      throw new Error("getUpdates returned no result array");
    }
    return res.result;
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        const offset = getOffset();
        const updates = await fetchOnce();
        let maxId = offset;
        for (const update of updates) {
          const updateId = (update as { update_id?: unknown }).update_id;
          if (typeof updateId === "number" && updateId > maxId) {
            maxId = updateId;
          }
          const msg = parseUpdate(update);
          if (msg && saveMessage(msg)) opts.onMessage(msg);
        }
        if (maxId > offset) setOffset(maxId + 1);
      } catch (err) {
        if (stopped) return;
        opts.onError?.(err);
        console.error(
          "[QuickReply] poll failed, retrying:",
          err instanceof Error ? err.message : String(err),
        );
        await sleep(5000);
      }
    }
  }

  void loop();
  return {
    stop() {
      stopped = true;
      currentChild?.kill("SIGTERM");
    },
  };
}
