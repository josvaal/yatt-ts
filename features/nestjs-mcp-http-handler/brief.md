# Feature Brief — NestJS / external-HTTP integration for yatt-ts

**Date:** 2026-09-19
**Slug:** nestjs-mcp-http-handler
**Workspace:** /home/codicore/yatt-ts

## Original request (VERBATIM)

User question (2026-09-19):
> pero yatt-ts es capaz de integrarse con nestjs? osea definir una ruta en la cual se expondrá el endpoint mcp?

Orchestrator's offer (the scope being accepted):
> ¿Querés que lo haga oficial: un helper `createMcpHttpHandler()` (mountable en cualquier ruta/framework) + el ejemplo NestJS completo en `examples/` + su test e2e? Es un feature chico y bien acotado.

User's confirmation (this feature's pedido):
> si, hazlo

## Explicit requirements extracted

- R1. A **`createMcpHttpHandler()` helper** in the yatt-ts public API that exposes the MCP endpoint as a plain request handler **mountable at any route/path of a host HTTP framework** (NestJS/Express/Fastify-raw), instead of (or besides) yatt-ts's own built-in HTTP server.
- R2. An **NestJS example** in `examples/` showing the integration (route/controller, lifecycle init/destroy).
- R3. An **e2e test** proving the handler works mounted through a real framework-style route (nested path, not only the built-in server).
- R4 (from the user's question context): this is for **embedding yatt-ts into an enterprise backend** (their words in GATE 1 of the previous feature: "integrarse a un backend de un sistema serio, empresarial") — host framework owns the HTTP surface and, typically, authentication.

## Decisions

- D1 (context, prior feature D23): still **one MCP client at a time** per YattServer instance (single engine/browser); the handler must keep the same new-wins eviction semantics as the built-in server.

### GATE 1 — user answers (2026-09-19)

- **Q1 → (a)**: `createMcpHttpHandler(yatt: YattServer, options?)` — wraps an EXISTING server handle; the host owns the lifecycle (init/destroy).
- **Q2 → (a)**: no auth by default (host framework guards rule); optional `authenticate(req)` hook → false = 401, throw = controlled 500.
- **Q3 → (a)**: `examples/09-nestjs-mcp-handler.ts` as a documented recipe (controller, lifecycle, guards) NOT compiled in-repo (Nest deps not installed), PLUS an e2e mounting the handler on a real nested route via express (devDep) as the stand-in for Nest's adapter.
- **Q4 → (a)**: CORS/OPTIONS OFF by default in the handler; opt-in `cors: { origins }` for standalone mounts (the built-in server keeps its current behavior — parity untouched).
