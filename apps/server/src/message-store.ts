// Message store. SQLite via node:sqlite, one file:
// apps/server/data/quickreply.db. Messages table per DEEP-DIVE §6.
// Offset for the Telegram poller lives in the meta table so it advances
// past every seen update, even ones with no text message.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rankInbox } from "./triage.js";

export type IncomingMessage = {
  id: string;
  update_id: number;
  chat_id: number;
  chat_title: string;
  /** Telegram user id of the sender (null when the update has none).
   * VIP matching uses this, never the display name. */
  sender_id: number | null;
  sender_name: string;
  text: string;
  created_at: string;
};

export type StoredMessage = IncomingMessage & { read: number };

let db: DatabaseSync | null = null;

/** DB path: next to this module (stable regardless of cwd); the tests
 * override it with QUICKREPLY_DB_PATH. Read lazily on first open so a test
 * can set the env var before its first store call. */
function dbPath(): string {
  const override = process.env.QUICKREPLY_DB_PATH;
  if (override) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "data", "quickreply.db");
}

function getDb(): DatabaseSync {
  if (db) return db;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      update_id INTEGER UNIQUE NOT NULL,
      chat_id INTEGER NOT NULL,
      chat_title TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS replies (
      slot INTEGER PRIMARY KEY,
      text TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS send_keys (
      key TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      chat_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS known_chats (
      chat_id INTEGER PRIMARY KEY,
      chat_title TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS allowed_chats (
      chat_id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vip_senders (
      sender_id INTEGER PRIMARY KEY
    );
  `);
  // Migration: sender_id arrived after the first messages were stored.
  // ALTER is idempotent here — it runs only when the column is missing,
  // so old databases (whose rows keep sender_id NULL) keep working.
  const columns = db
    .prepare("PRAGMA table_info(messages)")
    .all() as { name: string }[];
  if (!columns.some((c) => c.name === "sender_id")) {
    db.exec("ALTER TABLE messages ADD COLUMN sender_id INTEGER");
  }
  return db;
}

const DEFAULT_REPLIES = [
  "On my way",
  "Noted, will check",
  "Can't talk now",
  "Yes",
  "No",
];

/** The 5 canned reply slots, seeded with the defaults on first read. */
export function getReplies(): string[] {
  const database = getDb();
  const count = (
    database.prepare("SELECT COUNT(*) AS n FROM replies").get() as {
      n: number;
    }
  ).n;
  if (count === 0) {
    const now = new Date().toISOString();
    const insert = database.prepare(
      "INSERT INTO replies (slot, text, updated_at) VALUES (?, ?, ?)",
    );
    DEFAULT_REPLIES.forEach((text, i) => insert.run(i + 1, text, now));
  }
  const rows = database
    .prepare("SELECT text FROM replies ORDER BY slot ASC")
    .all() as { text: string }[];
  return rows.map((r) => r.text);
}

/**
 * Replaces all 5 reply slots. Returns false (and changes nothing) unless
 * the input is exactly 5 strings of 1–64 chars after trimming.
 */
export function setReplies(texts: string[]): boolean {
  if (texts.length !== 5) return false;
  const trimmed = texts.map((t) => t.trim());
  if (trimmed.some((t) => t.length === 0 || t.length > 64)) return false;
  const database = getDb();
  const now = new Date().toISOString();
  // Upsert, not UPDATE: the rows may not exist yet (the table is seeded
  // lazily by getReplies, and the tests clear it between cases).
  const upsert = database.prepare(
    `INSERT INTO replies (slot, text, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(slot) DO UPDATE SET text = excluded.text,
       updated_at = excluded.updated_at`,
  );
  trimmed.forEach((text, i) => upsert.run(i + 1, text, now));
  return true;
}

export function getMessage(id: string): StoredMessage | null {
  const row = getDb()
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToMessage(row) : null;
}

export function markRead(id: string): void {
  getDb().prepare("UPDATE messages SET read = 1 WHERE id = ?").run(id);
}

export function listChats(): { chat_id: number; chat_title: string }[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT chat_id, chat_title FROM messages
       ORDER BY chat_title ASC`,
    )
    .all() as { chat_id: number; chat_title: string }[];
  return rows;
}

// --- chat allowlist (default-deny). The bot only listens to
// chats the owner approved in the phone panel. A chat is "known" the
// first time the bot sees a message from it; it becomes "allowed" only
// by an explicit toggle (or by the one-time grandfather seed below).

export type KnownChat = {
  chat_id: number;
  chat_title: string;
  allowed: boolean;
};

/**
 * Records a sighting of a chat (title refreshes on rename). Returns true
 * when this is the FIRST time the bot has seen the chat.
 */
export function recordKnownChat(chatId: number, chatTitle: string): boolean {
  // An ON CONFLICT DO UPDATE also reports changes === 1, so check first:
  // only a genuinely new row counts as a first sighting.
  const database = getDb();
  const now = new Date().toISOString();
  const existing = database
    .prepare("SELECT chat_id FROM known_chats WHERE chat_id = ?")
    .get(chatId) as { chat_id: number } | undefined;
  if (existing) {
    database
      .prepare(
        "UPDATE known_chats SET chat_title = ?, last_seen_at = ? WHERE chat_id = ?",
      )
      .run(chatTitle, now, chatId);
    return false;
  }
  database
    .prepare(
      "INSERT INTO known_chats (chat_id, chat_title, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)",
    )
    .run(chatId, chatTitle, now, now);
  return true;
}

/** True only when the chat is explicitly allowlisted. Unknown chats are denied. */
export function isAllowedChat(chatId: number): boolean {
  const row = getDb()
    .prepare("SELECT chat_id FROM allowed_chats WHERE chat_id = ?")
    .get(chatId) as { chat_id: number } | undefined;
  return row !== undefined;
}

/**
 * Allows or blocks a KNOWN chat. Returns false (and changes nothing) for
 * an unknown chat — the panel only ever shows known chats, so an unknown
 * id here means a forged or stale message.
 */
export function setChatAllowed(chatId: number, allowed: boolean): boolean {
  const known = getDb()
    .prepare("SELECT chat_id FROM known_chats WHERE chat_id = ?")
    .get(chatId) as { chat_id: number } | undefined;
  if (!known) return false;
  const database = getDb();
  if (allowed) {
    database
      .prepare(
        "INSERT OR IGNORE INTO allowed_chats (chat_id, created_at) VALUES (?, ?)",
      )
      .run(chatId, new Date().toISOString());
  } else {
    database
      .prepare("DELETE FROM allowed_chats WHERE chat_id = ?")
      .run(chatId);
  }
  return true;
}

/** Every chat the bot has ever seen, with its allowed flag, by title. */
export function listKnownChats(): KnownChat[] {
  const rows = getDb()
    .prepare(
      `SELECT k.chat_id, k.chat_title,
              CASE WHEN a.chat_id IS NULL THEN 0 ELSE 1 END AS allowed
       FROM known_chats k LEFT JOIN allowed_chats a ON a.chat_id = k.chat_id
       ORDER BY k.chat_title ASC`,
    )
    .all() as { chat_id: number; chat_title: string; allowed: number }[];
  return rows.map((r) => ({
    chat_id: r.chat_id,
    chat_title: r.chat_title,
    allowed: r.allowed === 1,
  }));
}

/**
 * One-time grandfathering: every chat that already has stored messages
 * (i.e. chats the owner added the bot to before the allowlist existed)
 * becomes allowed. Runs ONCE — a `meta` flag records that it ran, so a
 * chat the user later toggled off is never silently re-allowed by a
 * server restart. Returns how many chats were newly allowed.
 * Chats first seen AFTER this runs are NOT grandfathered; they need an
 * explicit toggle.
 */
export function seedAllowedFromMessages(): number {
  const database = getDb();
  const flagged = database
    .prepare("SELECT value FROM meta WHERE key = 'allowlist_seeded'")
    .get() as { value: string } | undefined;
  if (flagged) return 0;
  const chats = database
    .prepare("SELECT DISTINCT chat_id, chat_title FROM messages")
    .all() as { chat_id: number; chat_title: string }[];
  let newly = 0;
  for (const c of chats) {
    recordKnownChat(c.chat_id, c.chat_title);
    const result = database
      .prepare(
        "INSERT OR IGNORE INTO allowed_chats (chat_id, created_at) VALUES (?, ?)",
      )
      .run(c.chat_id, new Date().toISOString());
    newly += Number(result.changes);
  }
  database
    .prepare("INSERT INTO meta (key, value) VALUES ('allowlist_seeded', '1')")
    .run();
  return newly;
}

export type StoredSend = {
  key: string;
  message_id: number;
  chat_id: number;
  text: string;
  result_json: string;
  created_at: string;
};

/** The stored receipt for an idempotency key, or null (never sent). */
export function getSend(key: string): StoredSend | null {
  const row = getDb()
    .prepare("SELECT * FROM send_keys WHERE key = ?")
    .get(key) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    key: String(row.key),
    message_id: Number(row.message_id),
    chat_id: Number(row.chat_id),
    text: String(row.text),
    result_json: String(row.result_json),
    created_at: String(row.created_at),
  };
}

/** Records a completed send under its idempotency key. */
/**
 * Records a send under its idempotency key. INSERT OR IGNORE: if two
 * concurrent sends with the same key both passed getSend, only the first
 * write wins and the second is a silent no-op — the caller
 * re-reads the stored receipt instead of surfacing a spurious failure.
 */
export function recordSend(
  key: string,
  messageId: number,
  chatId: number,
  text: string,
  resultJson: string,
): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO send_keys
         (key, message_id, chat_id, text, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(key, messageId, chatId, text, resultJson, new Date().toISOString());
}

function rowToMessage(row: Record<string, unknown>): StoredMessage {
  return {
    id: String(row.id),
    update_id: Number(row.update_id),
    chat_id: Number(row.chat_id),
    chat_title: String(row.chat_title),
    sender_id:
      row.sender_id === null || row.sender_id === undefined
        ? null
        : Number(row.sender_id),
    sender_name: String(row.sender_name),
    text: String(row.text),
    created_at: String(row.created_at),
    read: Number(row.read),
  };
}

/** Every distinct sender seen in stored messages, by name.
 * Senders with no id are skipped — VIP matching needs an id. */
export function listSenders(): { sender_id: number; sender_name: string }[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT sender_id, sender_name FROM messages
       WHERE sender_id IS NOT NULL
       ORDER BY sender_name ASC`,
    )
    .all() as { sender_id: number; sender_name: string }[];
  return rows.map((r) => ({
    sender_id: Number(r.sender_id),
    sender_name: String(r.sender_name),
  }));
}

/** Stores a message; returns false when its update_id is already stored. */
export function saveMessage(m: IncomingMessage): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO messages
         (id, update_id, chat_id, chat_title, sender_id, sender_name, text, created_at, read)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      m.id,
      m.update_id,
      m.chat_id,
      m.chat_title,
      m.sender_id,
      m.sender_name,
      m.text,
      m.created_at,
    );
  return result.changes === 1;
}

/** Inbox: unread first, then newest. */
export function listInbox(): StoredMessage[] {
  const rows = getDb().prepare("SELECT * FROM messages").all() as Record<
    string,
    unknown
  >[];
  // Ranking lives in triage.ts (VIP first, then unread, then newest) so
  // the sort is one pure function the tests can pin, not SQL.
  return rankInbox(rows.map(rowToMessage), listVips());
}

/** VIP senders, by Telegram user id. VIP is by id, never by name. */
export function listVips(): number[] {
  const rows = getDb()
    .prepare("SELECT sender_id FROM vip_senders ORDER BY sender_id ASC")
    .all() as { sender_id: number }[];
  return rows.map((r) => Number(r.sender_id));
}

/**
 * Sets VIP for a sender. Returns false when the sender is unknown — the
 * id must have been seen in a stored message first, so a typo or a
 * forged id can never create a VIP out of thin air.
 */
export function setVip(senderId: number, vip: boolean): boolean {
  const known = getDb()
    .prepare("SELECT 1 FROM messages WHERE sender_id = ? LIMIT 1")
    .get(senderId);
  if (!known) return false;
  if (vip) {
    getDb()
      .prepare("INSERT OR IGNORE INTO vip_senders (sender_id) VALUES (?)")
      .run(senderId);
  } else {
    getDb()
      .prepare("DELETE FROM vip_senders WHERE sender_id = ?")
      .run(senderId);
  }
  return true;
}

/** Next update_id the poller should ask Telegram for (0 = from the start). */
export function getOffset(): number {
  const row = getDb()
    .prepare("SELECT value FROM meta WHERE key = 'last_update_id'")
    .get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

export function setOffset(n: number): void {
  getDb()
    .prepare(
      `INSERT INTO meta (key, value) VALUES ('last_update_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(String(n));
}

/** Test-only seam (never used by production code). */
export function __clearAllForTests(): void {
  // The replies table is cleared too: getReplies() re-seeds the defaults
  // on the next read, so no test sees another test's saved replies.
  getDb().exec(
    "DELETE FROM messages; DELETE FROM meta; DELETE FROM replies; DELETE FROM send_keys; DELETE FROM known_chats; DELETE FROM allowed_chats; DELETE FROM vip_senders;",
  );
}
