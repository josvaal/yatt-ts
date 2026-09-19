# Feature Brief — yatt-ts npm library

**Date:** 2026-09-19
**Slug:** yatt-ts-npm-library
**Workspace:** /home/codicore/yatt-ts (new project)
**Base project:** /home/codicore/Proyectos/yatt

## Original request (VERBATIM)

> Quiero crear "yatt-ts" que sea una dependencia para npm de yatt, que levante su propio mcp yatt, custom, recontra pero recontra altamente configurables (accesos, permisos, restricciones, sesiones/sin sesiones guardadas, etc...) todo lo que te puedas imaginar, pero que sea una libreria npm alta pero altamente y recontra configurable y personalizable a gusto de cualquiera que lo instale. Y con todas las funcionalidades posibles y obviamente sumando las que ya tiene actualmente. Mi herramienta base está en "/home/codicore/Proyectos/yatt"

## Explicit requirements extracted

- R1. Create **"yatt-ts"** as an **npm dependency/library** (name is a hard constraint: `yatt-ts`).
- R2. It **lifts its own YATT MCP server** (custom): consumers install the package and get a working MCP server.
- R3. **Extremely configurable / customizable**: access, permissions, restrictions, sessions / no saved sessions, "everything you can imagine" — configurability is the core product value.
- R4. Include **all functionality possible**, plus **everything that exists today** in the base tool (35 MCP tools, resources, prompts, Playwright engine, headless runner, sessions, baselines, db_query).
- R5. Base tool location: `/home/codicore/Proyectos/yatt` (source to extract from — the library must be self-contained, NOT import from that repo at runtime).

## Decisions

- D1 (user, 2026-09-19): the npm package project lives in a **new folder `/home/codicore/yatt-ts`** (user correction — not inside the yatt repo).

### GATE 1 — user answers (2026-09-19, verbatim-wrapped)

1. **Package name**: `yatt-ts` plain (no scope).
2. **Runtime**: **Node AND Bun** (dual runtime; Node ≥22.5 primary).
3. **CLI**: yes — terminal command (`npx yatt-ts`) in addition to programmatic use.
4. **Access**: "clave secreta, pero con encriptacion obviamente, busca un metodo seguro" → token auth with a secure method (hashed storage + timing-safe comparison; token generated with crypto-secure randomness; never logged).
5. **Permissions granularity**: **both levels** — global read-only mode AND per-tool allow/deny.
6. **Blocked tools**: they **announce** they're not permitted (remain visible, clear permission error); denyBehavior option may hide them.
7. **Sessions "without saving"**: usable in-memory during the work session, **wiped on close** (function stays usable).
8. **Data location**: each consumer chooses its folder (defaults to project cwd).
9. **Desktop app data**: **compatible** — library can point at existing YATT desktop data (same format).
10. **Browsers**: "mi idea principal es que el paquete npm sea full headless pero con la capacidad de tomar capturas, etc.... asi que chromium" → **Chromium only, headless-first** (headless default ON; screenshots/preview still fully supported).
11. **Floating toolbar**: OFF by default.
12. **Browser download**: auto-download Chromium on first use.
13. **Configuration**: **in code** (programmatic config object; env/flags only for the CLI).
14. **Docs language**: **English + Spanish** (i18n for prompts/SCHEMA_DOC/messages; en default, es option).
15. **Fixes backport**: **library only** — base desktop app untouched.
16. **Old reports**: **optional cleanup** (retention config, OFF by default — nobody deletes without permission).
17. **Publish readiness**: prepared for public npm (license, metadata), nothing published by us.
18. **Initial version**: 0.1.0.
19. **Examples**: yes, recipes folder.
20. **Git**: yes, own git repo from day 1 (local commits only, nothing pushed).
21. **Config depth**: **everything adjustable** (all timeouts, viewport, every path) with sensible defaults.
22. **App-under-test DBs**: "si, solo los 2, pero puede llegar a integrarse a un backend de un sistema serio, empresarial, analiza mejor esa parte para optimizar el tema de seguridad con la conexion al mcp, como por ejemplo pasar la configuracion de una conexion typeorm" → keep SQLite + Postgres, with **enterprise-grade connection config** (TypeORM-style rich object: host/port/credentials/ssl; credentials never in argv).
23. **Concurrent AI clients**: one at a time.
24. **Extra dreams**: nothing extra for now.
