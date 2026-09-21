/**
 * Recipe 10 — Serve `db_query` from your OWN TypeORM/NestJS connection
 * (the `appDb: { type: 'provider' }` arm, C41).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  NOT TYPECHECKED/COMPILED IN THIS REPO: NestJS + TypeORM dependencies are
 *  not installed here, so this file is EXCLUDED from `tsconfig.test.json`
 *  and never runs in CI. To run it in a real Nest project:
 *
 *    npm i @nestjs/typeorm typeorm pg
 *    npm i yatt-ts
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * What it shows:
 *   - `appDb: { type: 'provider', provider }` hands yatt-ts YOUR query
 *     function. `db_query` executes IN YOUR PROCESS through your live
 *     `DataSource` (its pool, its credentials, its network position) — no
 *     engine child process is involved for this tool, so it works even with
 *     `engine: { enabled: false }`.
 *   - The provider contract is TypeORM's native shape: `(sql) =>
 *     dataSource.query(sql)` returning the FULL rows array. yatt-ts applies
 *     the read-only guard (SELECT/WITH/EXPLAIN/PRAGMA), the 30 s timeout and
 *     the 200-row output cap on top; `totalRows` keeps the real count.
 *   - HONEST BOUNDARY (R4): the headless runner's `db_assert`/`db_wait`
 *     steps execute in the engine child process, which CANNOT call back
 *     into this host function. With a provider-only config those runs are
 *     rejected with a clear message; configure `appDb` as sqlite/postgres
 *     (in addition to, or instead of, the provider) if you need db steps.
 *   - TIMEOUT NOTE: after the 30 s tool timeout yatt-ts stops WAITING but
 *     CANNOT cancel the query already handed to this provider (a JS
 *     limitation) — the statement keeps running on your DataSource pool.
 *     Set a host-side limit (PostgreSQL statement_timeout or a pool-level
 *     query timeout) so abandoned queries cannot pile up.
 *
 * SECURITY — defense in depth: yatt-ts enforces the read-only guard BEFORE
 * your function runs, but the DB privilege level is YOURS to own. Connect
 * the DataSource with a read-only role so a bypassed guard (or a human
 * mistake) still cannot mutate production data.
 */
import { Injectable, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { createYattServer, type YattServer } from '../src/index.js';

/**
 * Owns the YATT MCP server. `onModuleInit` boots it with the provider arm
 * pointed at the SAME DataSource the app uses; `onModuleDestroy` shuts it
 * down (flush + store close; the DataSource lifecycle stays with Nest).
 */
@Injectable()
export class YattService implements OnModuleInit, OnModuleDestroy {
  private yatt!: YattServer;

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    this.yatt = await createYattServer({
      paths: { root: process.env.YATT_ROOT ?? './yatt-data' },
      // Data-only embedding: no Chromium in the API process (ping answers
      // 'deferred'); db_query still works because it runs right here.
      engine: { enabled: false },
      appDb: {
        type: 'provider',
        // The one-liner this feature exists for: your live DataSource IS the
        // connection yatt-ts queries (full rows in; yatt caps the output).
        provider: (sql) => this.dataSource.query(sql),
      },
    });
    // stdio transport; or embed the endpoint in your HTTP layer with
    // createMcpHttpHandler (see recipe 09) — the appDb part is identical.
    await this.yatt.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.yatt.shutdown();
  }
}

/**
 * The app's own database module: your entities, YOUR read-only role.
 * Replace the credentials with your real config (env/vault); the account
 * yatt-ts ends up querying through should have SELECT-only grants.
 */
@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.APP_DB_HOST,
      port: Number(process.env.APP_DB_PORT ?? 5432),
      username: process.env.APP_DB_RO_USER, // read-only role: defense in depth
      password: process.env.APP_DB_RO_PASSWORD,
      database: process.env.APP_DB_NAME,
      // entities: [...],
      synchronize: false,
    }),
  ],
  providers: [YattService],
})
export class AppModule {}

/**
 * main.ts (for reference):
 *
 *   import 'reflect-metadata';
 *   import { NestFactory } from '@nestjs/core';
 *   import { AppModule } from './app.module';
 *
 *   async function bootstrap(): Promise<void> {
 *     const app = await NestFactory.create(AppModule);
 *     app.enableShutdownHooks(); // so yatt.shutdown() runs on SIGINT/SIGTERM
 *     await app.listen(3000);
 *   }
 *   void bootstrap();
 *
 * Connect any MCP client and call db_query, e.g.:
 *   { "sql": "SELECT status, count(*) FROM orders GROUP BY status" }
 * → executed through your DataSource, rows capped at 200 in the output.
 */
