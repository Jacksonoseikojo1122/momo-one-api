import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import type { Payment, Status } from "./types.js";

// Payments keep their full record as JSON plus the columns we query on. Webhook events
// go into an outbox and are delivered by a background loop, so a crash between "payment
// succeeded" and "tell the merchant" can't lose the notification.

export type PaymentRow = {
  payment: Payment;
  owner: string;
  idempotency_key: string;
  request_hash: string;
  next_check_at: number | null; // ms; null once final
  checks: number;
};

export type OutEvent = {
  id: string;
  owner: string;
  payment_id: string;
  type: string;
  created_at: string;
  body: string; // exactly what gets signed and sent
  attempts: number;
  next_attempt_at: number | null;
  delivered_at: string | null;
  last_error: string | null;
};

export interface Store {
  /** Inserts unless this owner already used the idempotency key. Returns what's stored. */
  createPayment(row: PaymentRow): Promise<{ row: PaymentRow; created: boolean }>;
  get(id: string): Promise<PaymentRow | undefined>;
  byReference(provider: string, reference: string): Promise<PaymentRow | undefined>;
  /**
   * Saves a new version only if the status is still `expected`. Webhooks, the reconciler and
   * API calls can race; this makes sure one of them wins cleanly instead of overwriting another.
   */
  update(row: PaymentRow, expected: Status): Promise<boolean>;
  list(owner: string, f: { status?: Status; direction?: string; limit: number }): Promise<Payment[]>;
  due(now: number, limit: number): Promise<PaymentRow[]>;
  completedSince(sinceIso: string, limit: number): Promise<PaymentRow[]>;
  addEvent(e: OutEvent): Promise<void>;
  dueEvents(now: number, limit: number): Promise<OutEvent[]>;
  saveEvent(e: OutEvent): Promise<void>;
  events(owner: string, paymentId?: string, limit?: number): Promise<OutEvent[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export const newId = (prefix: string) => prefix + "_" + randomBytes(12).toString("hex");

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    provider TEXT NOT NULL,
    reference TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    next_check_at BIGINT,
    checks INTEGER NOT NULL,
    doc TEXT NOT NULL,
    UNIQUE (owner, idempotency_key),
    UNIQUE (provider, reference)
  )`,
  `CREATE INDEX IF NOT EXISTS payments_due ON payments (next_check_at)`,
  `CREATE INDEX IF NOT EXISTS payments_owner ON payments (owner, created_at)`,
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    payment_id TEXT NOT NULL,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    next_attempt_at BIGINT,
    delivered_at TEXT,
    last_error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS events_due ON events (next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS events_payment ON events (payment_id, created_at)`,
];

type Exec = { all(sql: string, args: unknown[]): Promise<any[]>; run(sql: string, args: unknown[]): Promise<number> };

/** The same SQL on SQLite and Postgres; `?` placeholders become $1.. for Postgres. */
class SqlStore implements Store {
  constructor(private db: Exec, private onClose: () => Promise<void>) {}

  private toRow(r: any): PaymentRow {
    return {
      payment: JSON.parse(r.doc),
      owner: r.owner,
      idempotency_key: r.idempotency_key,
      request_hash: r.request_hash,
      next_check_at: r.next_check_at == null ? null : Number(r.next_check_at),
      checks: Number(r.checks),
    };
  }

  async createPayment(row: PaymentRow) {
    const p = row.payment;
    const n = await this.db.run(
      `INSERT INTO payments (id, owner, idempotency_key, request_hash, direction, status, provider, reference, created_at, updated_at, completed_at, next_check_at, checks, doc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (owner, idempotency_key) DO NOTHING`,
      [p.id, row.owner, row.idempotency_key, row.request_hash, p.direction, p.status, p.provider, p.reference, p.created_at, p.updated_at, p.completed_at, row.next_check_at, row.checks, JSON.stringify(p)],
    );
    const [r] = await this.db.all(`SELECT * FROM payments WHERE owner = ? AND idempotency_key = ?`, [row.owner, row.idempotency_key]);
    return { row: this.toRow(r), created: n === 1 };
  }

  async get(id: string) {
    const [r] = await this.db.all(`SELECT * FROM payments WHERE id = ?`, [id]);
    return r ? this.toRow(r) : undefined;
  }

  async byReference(provider: string, reference: string) {
    const [r] = await this.db.all(`SELECT * FROM payments WHERE provider = ? AND reference = ?`, [provider, reference]);
    return r ? this.toRow(r) : undefined;
  }

  async update(row: PaymentRow, expected: Status) {
    const p = row.payment;
    const n = await this.db.run(
      `UPDATE payments SET status = ?, updated_at = ?, completed_at = ?, next_check_at = ?, checks = ?, doc = ? WHERE id = ? AND status = ?`,
      [p.status, p.updated_at, p.completed_at, row.next_check_at, row.checks, JSON.stringify(p), p.id, expected],
    );
    return n === 1;
  }

  async list(owner: string, f: { status?: Status; direction?: string; limit: number }) {
    let sql = `SELECT doc FROM payments WHERE owner = ?`;
    const args: unknown[] = [owner];
    if (f.status) (sql += ` AND status = ?`), args.push(f.status);
    if (f.direction) (sql += ` AND direction = ?`), args.push(f.direction);
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    args.push(f.limit);
    return (await this.db.all(sql, args)).map((r) => JSON.parse(r.doc) as Payment);
  }

  async due(now: number, limit: number) {
    const rows = await this.db.all(`SELECT * FROM payments WHERE next_check_at IS NOT NULL AND next_check_at <= ? ORDER BY next_check_at LIMIT ?`, [now, limit]);
    return rows.map((r) => this.toRow(r));
  }

  async completedSince(sinceIso: string, limit: number) {
    const rows = await this.db.all(`SELECT * FROM payments WHERE completed_at IS NOT NULL AND completed_at >= ? ORDER BY completed_at LIMIT ?`, [sinceIso, limit]);
    return rows.map((r) => this.toRow(r));
  }

  async addEvent(e: OutEvent) {
    await this.db.run(
      `INSERT INTO events (id, owner, payment_id, type, created_at, body, attempts, next_attempt_at, delivered_at, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.id, e.owner, e.payment_id, e.type, e.created_at, e.body, e.attempts, e.next_attempt_at, e.delivered_at, e.last_error],
    );
  }

  async dueEvents(now: number, limit: number) {
    return (await this.db.all(`SELECT * FROM events WHERE next_attempt_at IS NOT NULL AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`, [now, limit])).map(evRow);
  }

  async saveEvent(e: OutEvent) {
    await this.db.run(`UPDATE events SET attempts = ?, next_attempt_at = ?, delivered_at = ?, last_error = ? WHERE id = ?`, [e.attempts, e.next_attempt_at, e.delivered_at, e.last_error, e.id]);
  }

  async events(owner: string, paymentId?: string, limit = 100) {
    const rows = paymentId
      ? await this.db.all(`SELECT * FROM events WHERE owner = ? AND payment_id = ? ORDER BY created_at LIMIT ?`, [owner, paymentId, limit])
      : await this.db.all(`SELECT * FROM events WHERE owner = ? ORDER BY created_at DESC LIMIT ?`, [owner, limit]);
    return rows.map(evRow);
  }

  async ping() {
    await this.db.all(`SELECT 1 AS ok`, []);
  }
  async close() {
    await this.onClose();
  }
}

const evRow = (r: any): OutEvent => ({
  ...r,
  attempts: Number(r.attempts),
  next_attempt_at: r.next_attempt_at == null ? null : Number(r.next_attempt_at),
});

export function sqliteStore(path = ":memory:"): Store {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  for (const s of SCHEMA) db.exec(s);
  return new SqlStore(
    {
      all: async (sql, args) => db.prepare(sql).all(...(args as any[])) as any[],
      run: async (sql, args) => Number(db.prepare(sql).run(...(args as any[])).changes),
    },
    async () => db.close(),
  );
}

export async function postgresStore(url: string): Promise<Store> {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  for (const s of SCHEMA) await pool.query(s);
  const q = (sql: string) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };
  return new SqlStore(
    {
      all: async (sql, args) => (await pool.query(q(sql), args as any[])).rows,
      run: async (sql, args) => (await pool.query(q(sql), args as any[])).rowCount ?? 0,
    },
    async () => pool.end(),
  );
}
