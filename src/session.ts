import { Database } from 'bun:sqlite';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';
import type { Message, ToolCall, TokenUsage } from './providers/base';

const DB_DIR = join(homedir(), '.askai');
const DB_PATH = join(DB_DIR, 'sessions.db');

let db: Database | null = null;

function getDatabase(): Database {
  if (db) return db;
  mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      last_token_speed REAL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      tool_call_id TEXT,
      seq INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
  `);
  ensureSessionColumn(database, 'prompt_tokens', 'INTEGER NOT NULL DEFAULT 0');
  ensureSessionColumn(database, 'completion_tokens', 'INTEGER NOT NULL DEFAULT 0');
  ensureSessionColumn(database, 'total_tokens', 'INTEGER NOT NULL DEFAULT 0');
  ensureSessionColumn(database, 'last_token_speed', 'REAL');
}

function ensureSessionColumn(database: Database, name: string, definition: string): void {
  const columns = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === name)) {
    database.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
  }
}

function generateId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 12; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export interface SessionSummary {
  id: string;
  title: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  last_token_speed: number | null;
  created_at: number;
  updated_at: number;
  message_count: number;
}

export interface SessionStorage {
  id: string;
  title: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  last_token_speed: number | null;
}

export function createSession(title: string, provider: string, model: string): SessionStorage {
  const database = getDatabase();
  const id = generateId();
  const now = Date.now();
  database.prepare(
    'INSERT INTO sessions (id, title, provider, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, title, provider, model, now, now);
  return {
    id,
    title,
    provider,
    model,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    last_token_speed: null,
  };
}

export function getSession(id: string): SessionStorage | null {
  const database = getDatabase();
  const row = database.prepare(
    'SELECT id, title, provider, model, prompt_tokens, completion_tokens, total_tokens, last_token_speed FROM sessions WHERE id = ?'
  ).get(id) as SessionStorage | undefined;
  return row || null;
}

export function addMessage(
  sessionId: string,
  role: string,
  content: string,
  toolCalls?: ToolCall[],
  toolCallId?: string,
): void {
  const database = getDatabase();
  const now = Date.now();
  const seqResult = database.prepare(
    'SELECT COALESCE(MAX(seq), -1) + 1 as next_seq FROM messages WHERE session_id = ?'
  ).get(sessionId) as { next_seq: number };
  database.prepare(
    'INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    sessionId,
    role,
    content,
    toolCalls ? JSON.stringify(toolCalls) : null,
    toolCallId || null,
    seqResult.next_seq,
    now,
  );
  database.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
}

export function getMessages(sessionId: string): Message[] {
  const database = getDatabase();
  const rows = database.prepare(
    'SELECT role, content, tool_calls, tool_call_id FROM messages WHERE session_id = ? ORDER BY seq ASC'
  ).all(sessionId) as Array<{ role: string; content: string; tool_calls: string | null; tool_call_id: string | null }>;
  return rows.map(row => {
    const msg: Message = {
      role: row.role as Message['role'],
      content: row.content,
    };
    if (row.tool_calls) {
      msg.tool_calls = JSON.parse(row.tool_calls) as ToolCall[];
    }
    if (row.tool_call_id) {
      msg.tool_call_id = row.tool_call_id;
    }
    return msg;
  });
}

export function listSessions(limit = 50): SessionSummary[] {
  const database = getDatabase();
  return database.prepare(`
    SELECT s.id, s.title, s.provider, s.model, s.prompt_tokens, s.completion_tokens, s.total_tokens, s.last_token_speed, s.created_at, s.updated_at,
      COUNT(CASE WHEN m.role != 'system' THEN 1 END) as message_count
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    GROUP BY s.id
    HAVING message_count > 0
    ORDER BY s.updated_at DESC
    LIMIT ?
  `).all(limit) as SessionSummary[];
}

export function renameSession(id: string, title: string): void {
  const database = getDatabase();
  database.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id);
}

export function recordSessionUsage(sessionId: string, usage?: TokenUsage, tokenSpeed?: number): SessionStorage | null {
  if (!usage && tokenSpeed === undefined) {
    return getSession(sessionId);
  }

  const database = getDatabase();
  const now = Date.now();
  database.prepare(`
    UPDATE sessions
    SET prompt_tokens = prompt_tokens + ?,
        completion_tokens = completion_tokens + ?,
        total_tokens = total_tokens + ?,
        last_token_speed = COALESCE(?, last_token_speed),
        updated_at = ?
    WHERE id = ?
  `).run(
    usage?.inputTokens ?? 0,
    usage?.outputTokens ?? 0,
    usage?.totalTokens ?? 0,
    tokenSpeed ?? null,
    now,
    sessionId,
  );
  return getSession(sessionId);
}

export function deleteSession(id: string): void {
  const database = getDatabase();
  database.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function autoGenerateTitle(firstMessage: string): string {
  const words = firstMessage.trim().replace(/\n/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length <= 20) return words.join(' ');
  return words.slice(0, 20).join(' ') + '...';
}

export function deleteEmptySessions(): void {
  const database = getDatabase();
  database.exec(`
    DELETE FROM sessions WHERE id IN (
      SELECT s.id FROM sessions s
      LEFT JOIN messages m ON m.session_id = s.id
      GROUP BY s.id
      HAVING COUNT(CASE WHEN m.role != 'system' THEN 1 END) = 0
    )
  `);
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
