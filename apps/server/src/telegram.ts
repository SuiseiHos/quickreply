// Telegram Bot API client. The token lives in the registered
// custom.telegram connection and is NEVER in this file, an env var, or a
// log. Every call shells out to the connector helper, which performs the
// surrogate exchange per call (see CONNECTOR.md: the raw-surrogate gotcha).
// Ruling: the server holds no TELEGRAM_BOT_TOKEN — the plan's "Consumes:
// TELEGRAM_BOT_TOKEN env" is superseded by the helper call, because the
// vaulted token cannot be read back into a long-running process.
import { execFile, type ChildProcess } from "node:child_process";
import {
  getOffset,
  isAllowedChat,
  recordKnownChat,
  saveMessage,
  setBusinessConnection,
  setChatAllowed,
  setOffset,
  type BusinessConnection,
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

/** The shape a Telegram send returns: the sent message. */
export type SentMessage = {
  message_id: number;
  chat: unknown;
  date: number;
  text: string;
};

/** Sends a text message; the transport is injectable so tests can use a
 * fake instead of delivering a real message to a real chat. When
 * `businessConnectionId` is set, Telegram delivers the message as sent by
 * the business account that owns that connection. */
export type SendTelegramFn = (
  chatId: number,
  text: string,
  businessConnectionId?: string,
) => Promise<SentMessage>;

/** Live getMe (read-only): proves the token + helper path work. */
export async function getMe(): Promise<{ ok: boolean; result: BotIdentity }> {
  const res = await callHelper(["getme"], 30000);
  if (res.ok !== true) {
    throw new Error(`getMe failed: ${JSON.stringify(res).slice(0, 200)}`);
  }
  return res as unknown as { ok: boolean; result: BotIdentity };
}

/**
 * Sends a text message to a chat (silent: disable_notification=true, so
 * the reply does not buzz the user's phone). Returns the sent message,
 * including its Telegram message_id. With a business connection id, the
 * message is sent as the business account, not the bot.
 */
export const sendMessage: SendTelegramFn = async (
  chatId,
  text,
  businessConnectionId,
) => {
  const args = [
    "sendmessage",
    "--chat-id",
    String(chatId),
    "--text",
    text,
    "--disable-notification",
  ];
  if (businessConnectionId) {
    args.push("--business-connection-id", businessConnectionId);
  }
  const res = await callHelper(args, 30000);
  if (res.ok !== true) {
    throw new Error(
      `sendMessage failed: ${JSON.stringify(res).slice(0, 200)}`,
    );
  }
  return res.result as SentMessage;
};

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
 * Converts a `business_connection` update into the stored connection, or
 * null when it is malformed. Telegram sends one whenever the connection
 * changes: the owner connects the bot, disconnects it, or `can_reply`
 * flips (e.g. after 24h without a customer message).
 */
export function parseBusinessConnection(update: unknown): BusinessConnection | null {
  if (typeof update !== "object" || update === null) return null;
  const c = (update as { business_connection?: unknown }).business_connection as
    | {
        id?: unknown;
        user_chat_id?: unknown;
        can_reply?: unknown;
        is_enabled?: unknown;
      }
    | undefined;
  if (!c || typeof c !== "object") return null;
  if (typeof c.id !== "string" || c.id.length === 0) return null;
  if (typeof c.user_chat_id !== "number") return null;
  if (typeof c.can_reply !== "boolean") return null;
  if (typeof c.is_enabled !== "boolean") return null;
  return {
    id: c.id,
    user_chat_id: c.user_chat_id,
    can_reply: c.can_reply,
    is_enabled: c.is_enabled,
  };
}

/**
 * Converts one raw update into a stored message, or null when it is not a
 * text message from a human sender (edits, photos, bot messages, ...).
 * Accepts both ordinary `message` updates and `business_message` updates
 * (same Message shape, plus the connection id from the envelope). The id
 * is chat_id:message_id — globally unique and deterministic.
 */
export function parseUpdate(update: unknown): IncomingMessage | null {
  if (typeof update !== "object" || update === null) return null;
  const u = update as {
    update_id?: unknown;
    message?: unknown;
    business_message?: unknown;
  };
  if (typeof u.update_id !== "number") return null;
  if (u.message !== undefined) {
    return parseMessageObject(u.update_id, u.message, null);
  }
  const bm = u.business_message as
    | { connection_id?: unknown; message?: unknown }
    | undefined;
  if (!bm || typeof bm !== "object") return null;
  if (typeof bm.connection_id !== "string" || bm.connection_id.length === 0) {
    return null;
  }
  return parseMessageObject(u.update_id, bm.message, bm.connection_id);
}

function parseMessageObject(
  updateId: number,
  raw: unknown,
  businessConnectionId: string | null,
): IncomingMessage | null {
  const m = raw as
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
    | { id?: unknown; first_name?: unknown; last_name?: unknown; is_bot?: unknown }
    | undefined;
  if (from?.is_bot === true) return null;
  const chat = m.chat as { id?: unknown; title?: unknown } | undefined;
  if (!chat || typeof chat.id !== "number") return null;
  if (typeof m.message_id !== "number") return null;
  const senderId = typeof from?.id === "number" ? from.id : null;
  const senderName =
    [from?.first_name, from?.last_name]
      .filter((part): part is string => typeof part === "string")
      .join(" ") || "Unknown";
  const chatTitle =
    typeof chat.title === "string" ? chat.title : senderName;
  const dateSeconds = typeof m.date === "number" ? m.date : 0;
  return {
    id: `${chat.id}:${m.message_id}`,
    update_id: updateId,
    chat_id: chat.id,
    chat_title: chatTitle,
    sender_id: senderId,
    sender_name: senderName,
    business_connection_id: businessConnectionId,
    text: m.text,
    created_at: new Date(dateSeconds * 1000).toISOString(),
  };
}

export type ChatMemberEvent = {
  chat_id: number;
  chat_title: string;
  status: "kicked" | "left";
};

/**
 * Converts a `my_chat_member` update into a removal event, or null.
 * Only kicked/left count: when a group admin removes the bot, the chat
 * must stop being allowlisted. A "member" (re-added) update
 * returns null — the chat stays as the panel left it, and the user can
 * re-allow it there.
 */
export function parseChatMemberUpdate(update: unknown): ChatMemberEvent | null {
  if (typeof update !== "object" || update === null) return null;
  const u = update as { my_chat_member?: unknown };
  const m = u.my_chat_member as
    | { chat?: unknown; new_chat_member?: unknown }
    | undefined;
  if (!m || typeof m !== "object") return null;
  const status = (m.new_chat_member as { status?: unknown } | undefined)?.status;
  if (status !== "kicked" && status !== "left") return null;
  const chat = m.chat as { id?: unknown; title?: unknown } | undefined;
  if (!chat || typeof chat.id !== "number") return null;
  return {
    chat_id: chat.id,
    chat_title: typeof chat.title === "string" ? chat.title : "Unknown chat",
    status,
  };
}

export type PollerOptions = {
  onMessage: (m: IncomingMessage) => void;
  /** Fires the first time a chat is seen (so the phone panel can show it
   * as pending approval). Fires for allowed chats too — once, on sighting. */
  onNewChat?: (chat: { chat_id: number; chat_title: string }) => void;
  /** Fires when the bot is removed from a chat (kicked/left). */
  onChatRemoved?: (chat: { chat_id: number; chat_title: string }) => void;
  /** Fires when a Telegram Business connection changes (connected,
   * disconnected, or can_reply flipped). */
  onBusinessConnection?: (conn: BusinessConnection) => void;
  onError?: (err: unknown) => void;
  /** Long-poll timeout per round in seconds (Telegram allows up to 50). */
  pollTimeoutSec?: number;
  /** Injectable fetch for tests; defaults to the real helper long-poll. */
  fetchUpdates?: (offset: number, timeoutSec: number) => Promise<unknown[]>;
};

/**
 * Long-poll loop: fetches updates, records every seen chat, stores and
 * forwards ONLY messages from allowlisted chats (default-deny),
 * advances the persisted offset past every seen update — including dropped
 * ones, so a blocked chat never causes a re-fetch loop — and calls
 * onMessage for each newly stored message. The bot has no commands:
 * message text is never executed; a "/anything" from anyone is just text
 * (dropped unless its chat is allowlisted). Never throws: a failed round
 * logs and retries after 5 s. stop() ends the loop and kills an in-flight
 * helper call.
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

  const fetchRound = opts.fetchUpdates ?? fetchOnce;

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        const offset = getOffset();
        const updates = await fetchRound(offset, pollTimeoutSec);
        for (const update of updates) {
          const updateId = (update as { update_id?: unknown }).update_id;
          if (typeof updateId === "number" && updateId > offset) {
            // Commit the offset PER UPDATE, right after that update is
            // processed: committing once at the end of the batch means a
            // throw — or a restart — mid-batch leaves the whole batch
            // unacknowledged, and Telegram re-delivers it. Per-update
            // commits shrink that window to the milliseconds of one
            // update; a re-fetch can still duplicate an allowed message,
            // but saveMessage dedupes by update_id, so nothing is lost
            // and nothing is delivered twice.
            processUpdate(update);
            setOffset(updateId + 1);
          } else {
            processUpdate(update);
          }
        }
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

  function processUpdate(update: unknown): void {
    // Business connection change: store it so the send path and the
    // phone panel know whether replies can go out as the business.
    const conn = parseBusinessConnection(update);
    if (conn) {
      setBusinessConnection(conn);
      opts.onBusinessConnection?.(conn);
      return;
    }
    // Bot removed from a chat: stop allowlisting it.
    // History stays in the inbox; a reply attempt fails cleanly
    // at Telegram with send-failed.
    const removed = parseChatMemberUpdate(update);
    if (removed) {
      recordKnownChat(removed.chat_id, removed.chat_title);
      setChatAllowed(removed.chat_id, false);
      opts.onChatRemoved?.({ chat_id: removed.chat_id, chat_title: removed.chat_title });
      return;
    }
    const msg = parseUpdate(update);
    if (!msg) return;
    // Every sighting is recorded (the phone panel shows pending
    // chats); only allowlisted chats reach the inbox + glasses.
    if (recordKnownChat(msg.chat_id, msg.chat_title)) {
      opts.onNewChat?.({ chat_id: msg.chat_id, chat_title: msg.chat_title });
    }
    if (isAllowedChat(msg.chat_id) && saveMessage(msg)) {
      opts.onMessage(msg);
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
