const { Client } = require('pg');

async function main() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('DATABASE_URL is required to run migrations.');
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();

  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  await client.query(`
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS request_queue (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'GET',
      payload JSONB,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INT NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_error TEXT
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS notes_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS cache_entries (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ
    );
  `);

  console.log('QuestCRM migrations applied successfully.');
  await client.end();
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
