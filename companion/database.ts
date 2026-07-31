import { DatabaseSync } from 'node:sqlite';

export type CompanionSummary = {
  issuedCredentials: number;
  activeExchanges: number;
  auditEvents: number;
};

export type ExchangeSession = {
  id: string;
  kind: string;
  state: string;
  expiresAt: number;
  data: Record<string, unknown>;
  outcome?: Record<string, unknown>;
};

export class CompanionDatabase {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS issued_credentials (
        id TEXT PRIMARY KEY,
        holder_did TEXT NOT NULL,
        compact TEXT NOT NULL,
        status_index INTEGER NOT NULL UNIQUE,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      ) STRICT;

      CREATE TABLE IF NOT EXISTS exchange_sessions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        outcome_json TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        category TEXT NOT NULL
      ) STRICT;
    `);
    this.database
      .prepare(
        `DELETE FROM exchange_sessions
         WHERE state NOT IN ('accepted', 'completed', 'denied', 'failed')`,
      )
      .run();
  }

  summary(nowSeconds: number): CompanionSummary {
    const issued = this.database
      .prepare('SELECT COUNT(*) AS count FROM issued_credentials')
      .get() as { count: number };
    const active = this.database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM exchange_sessions
         WHERE expires_at > ? AND state NOT IN
           ('accepted', 'completed', 'denied', 'failed')`,
      )
      .get(nowSeconds) as { count: number };
    const audit = this.database
      .prepare('SELECT COUNT(*) AS count FROM audit_events')
      .get() as { count: number };
    return {
      issuedCredentials: issued.count,
      activeExchanges: active.count,
      auditEvents: audit.count,
    };
  }

  createExchange(input: ExchangeSession): void {
    this.database
      .prepare(
        `INSERT INTO exchange_sessions
          (id, kind, state, expires_at, data_json, outcome_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.kind,
        input.state,
        input.expiresAt,
        JSON.stringify(input.data),
        input.outcome ? JSON.stringify(input.outcome) : null,
      );
  }

  getExchange(id: string): ExchangeSession | undefined {
    const row = this.database
      .prepare(
        `SELECT id, kind, state, expires_at, data_json, outcome_json
         FROM exchange_sessions WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          kind: string;
          state: string;
          expires_at: number;
          data_json: string;
          outcome_json: string | null;
        }
      | undefined;
    return row ? this.exchangeFromRow(row) : undefined;
  }

  findExchangeByData(field: string, value: string): ExchangeSession | undefined {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(field)) {
      throw new Error('invalid_exchange_field');
    }
    const row = this.database
      .prepare(
        `SELECT id, kind, state, expires_at, data_json, outcome_json
         FROM exchange_sessions
         WHERE json_extract(data_json, ?) = ?
         LIMIT 1`,
      )
      .get(`$.${field}`, value) as
      | {
          id: string;
          kind: string;
          state: string;
          expires_at: number;
          data_json: string;
          outcome_json: string | null;
        }
      | undefined;
    return row ? this.exchangeFromRow(row) : undefined;
  }

  updateExchange(
    id: string,
    state: string,
    data: Record<string, unknown>,
    outcome?: Record<string, unknown>,
    expiresAt?: number,
  ): void {
    this.database
      .prepare(
        `UPDATE exchange_sessions
         SET state = ?, data_json = ?, outcome_json = ?,
             expires_at = COALESCE(?, expires_at)
         WHERE id = ?`,
      )
      .run(
        state,
        JSON.stringify(data),
        outcome ? JSON.stringify(outcome) : null,
        expiresAt ?? null,
        id,
      );
  }

  nextStatusIndex(): number {
    const row = this.database
      .prepare(
        'SELECT COALESCE(MAX(status_index), -1) + 1 AS next FROM issued_credentials',
      )
      .get() as { next: number };
    return row.next;
  }

  insertCredential(input: {
    id: string;
    holderDid: string;
    compact: string;
    statusIndex: number;
    issuedAt: number;
    expiresAt: number;
  }): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          `UPDATE issued_credentials
           SET revoked_at = ?
           WHERE holder_did = ? AND revoked_at IS NULL`,
        )
        .run(input.issuedAt, input.holderDid);
      this.database
        .prepare(
          `INSERT INTO issued_credentials
            (id, holder_did, compact, status_index, issued_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.holderDid,
          input.compact,
          input.statusIndex,
          input.issuedAt,
          input.expiresAt,
        );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  isCredentialActive(statusIndex: number, nowSeconds: number): boolean {
    const row = this.database
      .prepare(
        `SELECT 1 AS active
         FROM issued_credentials
         WHERE status_index = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(statusIndex, nowSeconds) as { active: number } | undefined;
    return row?.active === 1;
  }

  hasActiveCredential(nowSeconds: number): boolean {
    const row = this.database
      .prepare(
        `SELECT 1 AS active
         FROM issued_credentials
         WHERE revoked_at IS NULL AND expires_at > ?
         LIMIT 1`,
      )
      .get(nowSeconds) as { active: number } | undefined;
    return row?.active === 1;
  }

  credentialStatuses(): boolean[] {
    const rows = this.database
      .prepare(
        `SELECT status_index, revoked_at
         FROM issued_credentials ORDER BY status_index`,
      )
      .all() as Array<{ status_index: number; revoked_at: number | null }>;
    if (!rows.length) return [];
    const statuses = Array.from(
      { length: rows.at(-1)!.status_index + 1 },
      () => false,
    );
    for (const row of rows) statuses[row.status_index] = row.revoked_at !== null;
    return statuses;
  }

  revokeActiveCredential(nowSeconds: number): boolean {
    const result = this.database
      .prepare(
        `UPDATE issued_credentials
         SET revoked_at = ?
         WHERE revoked_at IS NULL AND expires_at > ?`,
      )
      .run(nowSeconds, nowSeconds);
    return result.changes > 0;
  }

  resetDemo(): void {
    this.database.exec(`
      BEGIN IMMEDIATE;
      DELETE FROM exchange_sessions;
      DELETE FROM issued_credentials;
      DELETE FROM audit_events;
      COMMIT;
    `);
  }

  addAudit(nowSeconds: number, outcome: string, category: string): void {
    this.database
      .prepare(
        `INSERT INTO audit_events (occurred_at, outcome, category)
         VALUES (?, ?, ?)`,
      )
      .run(nowSeconds, outcome, category);
  }

  private exchangeFromRow(row: {
    id: string;
    kind: string;
    state: string;
    expires_at: number;
    data_json: string;
    outcome_json: string | null;
  }): ExchangeSession {
    return {
      id: row.id,
      kind: row.kind,
      state: row.state,
      expiresAt: row.expires_at,
      data: JSON.parse(row.data_json) as Record<string, unknown>,
      ...(row.outcome_json
        ? { outcome: JSON.parse(row.outcome_json) as Record<string, unknown> }
        : {}),
    };
  }

  close(): void {
    this.database.close();
  }
}
