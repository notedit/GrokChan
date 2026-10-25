import { DurableObject } from "cloudflare:workers";

export const MAX_TURNS = 30; // history cap per session
export const TURN_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export type Role = "user" | "assistant";
export type Turn = { id: number; role: Role; text: string; ts: number };
export interface BeginResult {
  token: string;
  turnId: number;
  history: { role: Role; text: string }[];
}
export type ConsumeResult = "ok" | "unknown" | "expired";

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Single Durable Object (SQLite) holding all state: turns, one-time reply
 * tokens, and fixed-window rate limit counters. One object is plenty for a
 * personal chat page, and a single-threaded object makes token consumption
 * trivially atomic.
 */
export class ChatHub extends DurableObject<Record<string, unknown>> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turns_session ON turns (session_id, id);
      CREATE TABLE IF NOT EXISTS tokens (
        token TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tokens_session ON tokens (session_id);
      CREATE TABLE IF NOT EXISTS rl (
        key TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL
      );
    `);
  }

  private prune(now: number, sessionId?: string): void {
    this.sql.exec("DELETE FROM turns WHERE ts < ?", now - TURN_TTL_MS);
    // Keep expired tokens for a while so late replies get a clear 410, not 404.
    this.sql.exec("DELETE FROM tokens WHERE expires_at < ?", now - 60 * 60 * 1000);
    this.sql.exec("DELETE FROM rl WHERE window_start < ?", now - 10 * 60 * 1000);
    if (sessionId) {
      this.sql.exec(
        `DELETE FROM turns WHERE session_id = ? AND id NOT IN
           (SELECT id FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT ?)`,
        sessionId,
        sessionId,
        MAX_TURNS,
      );
    }
  }

  /** Fixed-window counter. Returns true when the call is allowed. */
  rateLimit(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const row = this.sql
      .exec<{ window_start: number; count: number }>("SELECT window_start, count FROM rl WHERE key = ?", key)
      .toArray()[0];
    if (!row || now - row.window_start >= windowMs) {
      this.sql.exec("INSERT OR REPLACE INTO rl (key, window_start, count) VALUES (?, ?, 1)", key, now);
      return true;
    }
    if (row.count >= limit) return false;
    this.sql.exec("UPDATE rl SET count = count + 1 WHERE key = ?", key);
    return true;
  }

  /** Read-only check of a counter (used for failed-login throttling). */
  rateLimited(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const row = this.sql
      .exec<{ window_start: number; count: number }>("SELECT window_start, count FROM rl WHERE key = ?", key)
      .toArray()[0];
    return !!row && now - row.window_start < windowMs && row.count >= limit;
  }

  /** Store the user turn, mint a one-time reply token, return prior history. */
  begin(sessionId: string, message: string, tokenTtlMs: number): BeginResult {
    const now = Date.now();
    this.prune(now);
    const history = this.sql
      .exec<{ role: Role; text: string }>(
        "SELECT role, text FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT ?",
        sessionId,
        MAX_TURNS,
      )
      .toArray()
      .reverse();
    const turnId = this.sql
      .exec<{ id: number }>(
        "INSERT INTO turns (session_id, role, text, ts) VALUES (?, 'user', ?, ?) RETURNING id",
        sessionId,
        message,
        now,
      )
      .one().id;
    const token = randomToken();
    this.sql.exec("INSERT INTO tokens (token, session_id, expires_at) VALUES (?, ?, ?)", token, sessionId, now + tokenTtlMs);
    this.prune(now, sessionId);
    return { token, turnId, history };
  }

  /** Webhook delivery failed for good: forget the token and the user turn. */
  abort(token: string, turnId: number): void {
    this.sql.exec("DELETE FROM tokens WHERE token = ?", token);
    this.sql.exec("DELETE FROM turns WHERE id = ? AND role = 'user'", turnId);
  }

  /** Validate + consume a reply token and store the assistant turn atomically. */
  consume(token: string, text: string): ConsumeResult {
    const now = Date.now();
    const row = this.sql
      .exec<{ session_id: string; expires_at: number }>("SELECT session_id, expires_at FROM tokens WHERE token = ?", token)
      .toArray()[0];
    if (!row) return "unknown";
    this.sql.exec("DELETE FROM tokens WHERE token = ?", token); // single use either way
    if (row.expires_at < now) return "expired";
    this.sql.exec(
      "INSERT INTO turns (session_id, role, text, ts) VALUES (?, 'assistant', ?, ?)",
      row.session_id,
      text,
      now,
    );
    this.prune(now, row.session_id);
    return "ok";
  }

  poll(sessionId: string, after: number): { turns: Turn[]; pending: boolean } {
    const now = Date.now();
    const turns = this.sql
      .exec<Turn>(
        "SELECT id, role, text, ts FROM turns WHERE session_id = ? AND role = 'assistant' AND id > ? AND ts >= ? ORDER BY id",
        sessionId,
        after,
        now - TURN_TTL_MS,
      )
      .toArray();
    return { turns, pending: this.pending(sessionId, now) };
  }

  history(sessionId: string): { turns: Turn[]; pending: boolean } {
    const now = Date.now();
    const turns = this.sql
      .exec<Turn>(
        "SELECT id, role, text, ts FROM turns WHERE session_id = ? AND ts >= ? ORDER BY id",
        sessionId,
        now - TURN_TTL_MS,
      )
      .toArray();
    return { turns, pending: this.pending(sessionId, now) };
  }

  private pending(sessionId: string, now: number): boolean {
    return (
      this.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM tokens WHERE session_id = ? AND expires_at > ?", sessionId, now)
        .one().n > 0
    );
  }

  reset(sessionId: string): void {
    this.sql.exec("DELETE FROM turns WHERE session_id = ?", sessionId);
    this.sql.exec("DELETE FROM tokens WHERE session_id = ?", sessionId);
  }
}
