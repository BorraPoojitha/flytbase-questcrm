import { ensureDatabaseReady, withDbClient } from "@/lib/db";

export interface QueueItem {
  id: string;
  endpoint: string;
  method: string;
  payload: Record<string, unknown> | null;
  status: "queued" | "processing" | "done" | "failed";
  attempts: number;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string | null;
}

export async function enqueueRequest(endpoint: string, method = "GET", payload?: Record<string, unknown>) {
  await ensureDatabaseReady();

  return withDbClient(async (client) => {
    const result = await client.query(
      `INSERT INTO request_queue (endpoint, method, payload, status, next_attempt_at)
       VALUES ($1, $2, $3, 'queued', NOW())
       RETURNING *`,
      [endpoint, method, payload ?? null],
    );

    return result.rows[0] as QueueItem;
  });
}

export async function lockNextQueuedRequest(): Promise<QueueItem | null> {
  await ensureDatabaseReady();

  return withDbClient(async (client) => {
    await client.query(`BEGIN`);

    try {
      const result = await client.query(
        `SELECT *
         FROM request_queue
         WHERE status IN ('queued', 'failed')
           AND next_attempt_at <= NOW()
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );

      if (result.rowCount === 0) {
        await client.query(`COMMIT`);
        return null;
      }

      const item = result.rows[0];
      await client.query(
        `UPDATE request_queue
         SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
         WHERE id = $1`,
        [item.id],
      );

      await client.query(`COMMIT`);
      return {
        id: item.id,
        endpoint: item.endpoint,
        method: item.method,
        payload: item.payload,
        status: "processing",
        attempts: Number(item.attempts) + 1,
        nextAttemptAt: new Date().toISOString(),
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      } as QueueItem;
    } catch (error) {
      await client.query(`ROLLBACK`);
      throw error;
    }
  });
}

export async function finishQueuedRequest(id: string, success: boolean, errorMessage?: string) {
  await ensureDatabaseReady();

  await withDbClient(async (client) => {
    if (success) {
      await client.query(
        `UPDATE request_queue
         SET status = 'done', updated_at = NOW(), last_error = NULL, next_attempt_at = NOW() + INTERVAL '60 seconds'
         WHERE id = $1`,
        [id],
      );
      return;
    }

    await client.query(
      `UPDATE request_queue
       SET status = 'failed', updated_at = NOW(), last_error = $1, next_attempt_at = NOW() + INTERVAL '60 seconds'
       WHERE id = $1`,
      [errorMessage || "Questathon request failed", id],
    );
  });
}

export async function queueStatusSummary() {
  await ensureDatabaseReady();

  return withDbClient(async (client) => {
    const result = await client.query(
      `SELECT status, COUNT(*)::int AS count
       FROM request_queue
       GROUP BY status`,
    );

    return result.rows;
  });
}
