// Message store (Task 2). SQLite via node:sqlite, one file:
// apps/server/data/quickreply.db. Messages table per DEEP-DIVE §6.
// Offset for the Telegram poller lives in the meta table so it advances
// past every seen update, even ones with no text message.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type IncomingMessage = {
  id: string;
  update_id: number;
  chat_id: number;
  chat_title: string;
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
  `);
  return db;
}

function rowToMessage(row: Record<string, unknown>): StoredMessage {
  return {
    id: String(row.id),
    update_id: Number(row.update_id),
    chat_id: Number(row.chat_id),
    chat_title: String(row.chat_title),
    sender_name: String(row.sender_name),
    text: String(row.text),
    created_at: String(row.created_at),
    read: Number(row.read),
  };
}

/** Stores a message; returns false when its update_id is already stored. */
export function saveMessage(m: IncomingMessage): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO messages
         (id, update_id, chat_id, chat_title, sender_name, text, created_at, read)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      m.id,
      m.update_id,
      m.chat_id,
      m.chat_title,
      m.sender_name,
      m.text,
      m.created_at,
    );
  return result.changes === 1;
}

/** Inbox: unread first, then newest. */
export function listInbox(): StoredMessage[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM messages
       ORDER BY read ASC, created_at DESC, update_id DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToMessage);
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
  getDb().exec("DELETE FROM messages; DELETE FROM meta;");
}
