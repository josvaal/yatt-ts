/**
 * Recipe 08 — App-under-test database as a rich config object (C21, D22).
 *
 * `db_query` runs read-only SQL against the application your tests exercise.
 * Instead of an env var, you pass a TypeORM-style connection object in the
 * config — SQLite or Postgres:
 *
 * - Postgres accepts host/port/user/database/ssl and the password EITHER as
 *   a string OR as a `passwordProvider` function (sync or async) so the
 *   secret can come from a vault, KMS, or your process env AT CALL TIME.
 * - Credentials travel to the engine via a private environment variable —
 *   NEVER in argv, never logged.
 *
 * NOTE: this recipe boots fine without a live Postgres; `db_query` only
 * fails (with a clear connection error) when something actually queries a
 * database that is not reachable.
 *
 *   node examples/08-appdb-postgres-object.ts
 */
import { createYattServer } from '../src/index.js';

const server = await createYattServer({
  engine: { enabled: true }, // db_query runs through the engine
  appDb: {
    type: 'postgres',
    host: 'db.internal.example.com',
    port: 5432,
    user: 'readonly_user',
    database: 'production_app',
    // Resolve the secret at call time — from env, a vault, wherever.
    passwordProvider: async () => process.env.APP_DB_PASSWORD ?? '',
    ssl: { rejectUnauthorized: true },
  },
  // SQLite shape for local apps:
  // appDb: { type: 'sqlite', file: './dev-app.db' },
});

process.on('SIGINT', () => {
  void server.shutdown().then(() => process.exit(0));
});

await server.start(); // stdio
console.error('[recipe-08] ready — db_query will use the configured Postgres connection');
