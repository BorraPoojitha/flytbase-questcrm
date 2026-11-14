# FlytBase Questathon CRM – Architecture and deployment notes

## Goal
This project is a read-only CRM dashboard for the two target accounts:
- Eastern Counties Police Alliance
- Aldermoor Industrial Group

It uses the Questathon public API only server-side, with caching and a shared request queue so we never exceed the upstream rate limit of one request per minute per token.

## Key rules
- `AQ_TOKEN` is only read on the server and is never exposed in the browser or logs.
- `GET /api/public/v1/export` is the initial sync trigger and the most important dataset.
- Additional upstream calls are only attempted when the rate limiter allows them.
- All writes are sent via a server API route and not directly from the browser.
- Without a valid `AQ_TOKEN`, the app shows a safe empty state instead of inventing numbers or names.

## Data handling strategy
1. Fetch `export` first and normalize all relevant records.
2. Use the normalized export to populate account cards, relationship fields, risks, next moves and knowledge gaps.
3. Use the rate-limited queue to progressively pull additional data from `signals`, `notes`, `schema`, `pack/A/all` and `pack/B/all` only when permitted.
4. Store the result in a persistent cache layer in production. The local app uses an in-memory cache for demo purposes; this is not durable on Vercel.
5. Only display values that are actually present; otherwise render `Unknown` and `Status: unknown`.

## Production deployment
For durable operation on Vercel, use a managed Postgres or equivalent database and configure:
- `DATABASE_URL`
- `AQ_TOKEN`
- `ADMIN_ACCESS_KEY`

Then add a small cache/queue table and replace the in-memory default store with a database-backed implementation.

## Notes
- The dashboard is intentionally conservative: it does not claim live sync, verified financial values, or write success unless a real upstream request has happened.
- The admin notes interface is read-only to the public and requires a server-side secret to write comments back to the upstream API.
