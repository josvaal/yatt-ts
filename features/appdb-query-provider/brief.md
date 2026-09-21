# Feature Brief — in-process app-DB query provider

**Date:** 2026-09-19
**Slug:** appdb-query-provider
**Workspace:** /home/codicore/yatt-ts (HEAD `8ec24da`)

## Original request (VERBATIM)

> 2

(respuesta a la pregunta del orquestador:)
> ¿Cuál querés: la 1, la 2, o las dos? (La 1 te la hago enseguida; la 2 arranca feature propio con sus gates porque cambia la frontera de proceso.)

Y el contexto de la pregunta (mismo turno):
> **Opción 2 — Query provider inyectable** — para embedding: le pasás a yatt-ts tu **propia función de query** (backeada por tu `DataSource` vivo de TypeORM, con su pool) y `db_query` ejecuta en tu proceso en vez de en el hijo del engine. Es la única forma de usar tu conexión existente de verdad — pero es un feature real: cambia la frontera de proceso y el guard read-only debe re-validarse del lado host.

## Explicit requirements extracted

- R1. New `appDb` mode that lets an embedding host (NestJS/TypeORM, etc.) provide its **own query function** backed by a live connection/pool (e.g. `dataSource.query`).
- R2. `db_query` executes **in the host process** through that function — no engine child process involved for this tool (works even with `engine.enabled: false`).
- R3. Security posture preserved: read-only guard, timeout and row cap must keep applying to provider-routed queries (the host ALSO owns the DB privilege level — document it).
- R4. Honest scope boundary: the engine child (headless runner db_assert/db_wait steps) CANNOT use a host function — needs sqlite/postgres config or fails with a CLEAR message.

## Decisions

- D1 (prior features, still binding): strict config (unknown keys rejected), credentials/secrets never in argv, D23 one client at a time, embedded-mode philosophy (host owns lifecycle).

### GATE 1 — user answers (2026-09-19)

- **Q1 → (a)**: config arm is `appDb: { type: 'provider', provider: async (sql) => rows }` — keeps the discriminated union and strict validation.
- **Q2 → (a)**: provider returns `Promise<Record<string, unknown>[]>` (full rows; exactly TypeORM's `dataSource.query(sql)` shape). yatt caps output to 200 and reports `totalRows`.
- **Q3 → (a)**: `test_run` db steps with provider-only config → one-line startup notice + clear i18n error at the step (needs sqlite/postgres for the child process).
- **Q4 → yes** (answered as "5 si"): include `examples/10-typeorm-provider.ts` (NestJS recipe with a live DataSource) + README en/es section on the provider and the read-only-role recommendation.
