# FlytBase Questathon CRM

This application is a production-oriented Next.js CRM built around the Questathon public export and a server-only sync layer.

## Features
- Public read-only dashboard for the two target accounts
- Read-only display of evidence, stakeholders, risks and gaps
- Server-side Questathon sync using `AQ_TOKEN`
- Postgres-backed cache, sync state and request coordination
- Shared request queue to respect the upstream one-request-per-minute-per-token limit
- Admin note writes queued through the server before upstream verification
- Audit log for note submissions

## Environment variables
Create a `.env.local` file in the project root with:

```bash
AQ_TOKEN=your_questathon_token
QUESTATHON_BASE_URL=https://questathon.aihackerscollective.com
ADMIN_ACCESS_KEY=replace_with_admin_secret
DATABASE_URL=postgres://user:password@host:5432/db_name
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Never commit `.env.local`.

## Local development
```bash
npm install
npm run migrate
npm run dev
```

Open `http://localhost:3000`.

## Vercel deployment
1. Push the app to GitHub.
2. In Vercel, import the repository.
3. Add the environment variables listed above, especially `DATABASE_URL`.
4. Ensure the Postgres database is reachable from Vercel.
5. Run the migration job on the deployed database:

```bash
npm run migrate
```

6. Deploy the project.

Important: local filesystem storage is not durable on Vercel; this project uses Postgres for persistent cache and coordination.

## Production notes
- `AQ_TOKEN` and `ADMIN_ACCESS_KEY` are never exposed to the browser or logs.
- The shared queue ensures only one upstream request is executed per minute per token.
- Note writes are queued and recorded in the DB; they are only considered successful after the server has actually confirmed them upstream.
- The app does not claim live sync unless a real request has completed successfully.
