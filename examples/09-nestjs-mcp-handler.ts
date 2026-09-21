/**
 * Recipe 09 — Embed the YATT MCP endpoint inside a NestJS application.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  NOT TYPECHECKED/COMPILED IN THIS REPO: NestJS dependencies are not
 *  installed here, so this file is EXCLUDED from `tsconfig.test.json` and
 *  never runs in CI. To run it in a real Nest project:
 *
 *    npm i @nestjs/common @nestjs/platform-express reflect-metadata rxjs
 *    npm i yatt-ts
 *
 *  then copy the classes below (or generate a controller/service with the
 *  Nest CLI and paste the bodies). Works with the default Express adapter.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * What it shows:
 *   - `createMcpHttpHandler()` mounts the MCP endpoint at ANY route of the
 *     host app (`POST/GET/DELETE /api/mcp`) instead of running the built-in
 *     standalone HTTP server (`http.enabled`). The host framework owns the
 *     HTTP surface: middleware, CORS, TLS, rate limiting, guards.
 *   - Lifecycle: `onModuleInit` creates the YattServer + handler; the
 *     handler manages `server.connect()` per MCP session itself, so
 *     `yatt.start()` is NOT called (and must NOT be called) in this mode.
 *   - Teardown: `onModuleDestroy` closes the handler first (all sessions),
 *     then the server (flush + store + engine). Requires
 *     `app.enableShutdownHooks()` in main.ts (see the snippet at the bottom).
 *   - Body: the framework already parsed the JSON body (`req.body`), so it
 *     is passed as the third argument — the raw stream is never re-read.
 *   - Auth: Nest guards run BEFORE the controller method, so a guard is the
 *     natural place for bearer checks. The optional `authenticate` hook of
 *     `createMcpHttpHandler()` exists for host setups that prefer it.
 *
 * One MCP client at a time per YattServer (engine constraint): when a
 * second client initializes, the stale session is evicted automatically.
 */
import {
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import {
  createMcpHttpHandler,
  createYattServer,
  type McpHttpHandler,
  type YattServer,
} from '../src/index.js';

/**
 * Auth guard (optional but recommended): bearer check at the edge, before
 * any MCP traffic. Replace with your real auth (JWT, API keys, OIDC…).
 * With guards in place you do NOT need the handler's `authenticate` hook.
 */
@Injectable()
export class BearerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization ?? '';
    return header === `Bearer ${process.env.YATT_TOKEN ?? 'change-me-at-least-16-chars'}`;
  }
}

/** Owns the YattServer + the mounted MCP handler. */
@Injectable()
export class McpService implements OnModuleInit, OnModuleDestroy {
  private yatt!: YattServer;
  private handler!: McpHttpHandler;

  async onModuleInit(): Promise<void> {
    // Handler mode: do NOT call yatt.start() — the handler connects the
    // MCP server per session itself; the embedder owns the lifecycle.
    this.yatt = await createYattServer({
      paths: { root: process.env.YATT_ROOT ?? './yatt-data' },
      // Backend-typical: no Chromium inside the API process (ping answers
      // 'deferred'; test authoring/report tools still work).
      engine: { enabled: false },
      // auth: NOT configured here — the Nest guard above rules the edge.
    });
    this.handler = createMcpHttpHandler(this.yatt, {
      // Optional per-request hook if you prefer handler-level auth over a
      // guard: false → 401 { error: 'unauthorized' }, throw → controlled 500.
      // authenticate: (req) => checkBearer(req),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.handler.close(); // close every live MCP session first
    await this.yatt.shutdown(); // then flush sessions + close store/engine
  }

  /** Bridges one Nest route into the MCP handler. */
  handle(request: Request, response: Response): void {
    // EXPRESS ADAPTER ONLY (Nest's default): `request` IS the
    // http.IncomingMessage and `response` IS the http.ServerResponse, so
    // both pass through to the handler unchanged. Other adapters wrap these
    // objects (e.g. Fastify's reply) and are NOT covered by this recipe.
    // `request.body` is already parsed by the framework → third argument.
    void this.handler.handle(request, response, request.body);
  }
}

/** The MCP endpoint lives at the NESTED route /api/mcp of the host app. */
@Controller('api')
@UseGuards(BearerGuard)
export class McpController {
  constructor(private readonly mcp: McpService) {}

  @Post('mcp')
  post(@Req() request: Request, @Res() response: Response): void {
    this.mcp.handle(request, response);
  }

  @Get('mcp') // standalone SSE stream (session-bound)
  get(@Req() request: Request, @Res() response: Response): void {
    this.mcp.handle(request, response);
  }

  @Delete('mcp') // explicit session termination (session-bound)
  delete(@Req() request: Request, @Res() response: Response): void {
    this.mcp.handle(request, response);
  }
}

@Module({
  controllers: [McpController],
  providers: [McpService, BearerGuard],
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
 *     // Without this, Nest never fires onModuleDestroy on SIGINT/SIGTERM —
 *     // handler.close() and yatt.shutdown() would never run.
 *     app.enableShutdownHooks();
 *     await app.listen(3000);
 *   }
 *   void bootstrap();
 *
 * Connect an MCP client to http://localhost:3000/api/mcp with header
 * `Authorization: Bearer <YATT_TOKEN>`.
 */
