import { ensureDatabaseReady, withDbClient } from "@/lib/db";

export interface SyncStateValue {
  lastSyncedAt: string | null;
  status: "idle" | "ready" | "stale" | "error";
  message: string;
  rateLimit: {
    perMinute: number;
    nextAvailableAt: string | null;
    lastRequestAt: string | null;
  };
}

export async function loadPersistenceState<T>(key: string, fallback: T): Promise<T> {
  await ensureDatabaseReady();

  return withDbClient(async (client) => {
    const result = await client.query("SELECT value FROM sync_state WHERE key = $1", [key]);
    if (result.rowCount === 0) {
      await client.query("INSERT INTO sync_state (key, value) VALUES ($1, $2)", [key, JSON.stringify(fallback)]);
      return fallback;
    }

    return result.rows[0].value as T;
  });
}

export async function savePersistenceState<T>(key: string, value: T) {
  await ensureDatabaseReady();

  await withDbClient(async (client) => {
    await client.query(
      `INSERT INTO sync_state (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)],
    );
  });
}

export async function saveCacheEntry<T>(key: string, value: T, ttlMs?: number) {
  await ensureDatabaseReady();

  await withDbClient(async (client) => {
    const expiresAt = ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null;
    await client.query(
      `INSERT INTO cache_entries (key, value, expires_at, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, updated_at = NOW()`,
      [key, JSON.stringify(value), expiresAt],
    );
  });
}

export async function loadCacheEntry<T>(key: string): Promise<T | null> {
  await ensureDatabaseReady();

  return withDbClient(async (client) => {
    const result = await client.query(
      `SELECT value, expires_at FROM cache_entries WHERE key = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
      [key],
    );

    if (result.rowCount === 0) return null;
    return result.rows[0].value as T;
  });
}

export async function recordNotesAudit(input: {
  account: string;
  kind: string;
  title: string;
  text: string;
  source: string;
}) {
  await ensureDatabaseReady();

  await withDbClient(async (client) => {
    await client.query(
      `INSERT INTO notes_audit (account, kind, title, text, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.account, input.kind, input.title, input.text, input.source],
    );
  });
}

export async function listNotesAudit(limit = 50) {
  await ensureDatabaseReady();

  return withDbClient(async (client) => {
    const result = await client.query(
      `SELECT account, kind, title, text, source, created_at
       FROM notes_audit ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );

    return result.rows;
  });
}
