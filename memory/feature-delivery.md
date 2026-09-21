---
name: Feature delivery appdb-query-provider
description: Resultado GATE 2 del feature de query provider in-proceso para yatt-ts (2026-09-19)
type: decision
---

# Delivery — appdb-query-provider

**What**: `appDb: { type: 'provider', provider: async (sql) => rows[] }` — brazo nuevo de config que deja al host (NestJS/TypeORM) servir `db_query` con SU función/SU pool EN PROCESO, sin proceso hijo del engine. Guard read-only + multi-statement, timeout 30s, cap 200/totalRows aplican en la capa del tool. Frontera dura documentada: db_assert/db_wait de test_run corren en el hijo y necesitan sqlite/postgres (pre-flight con resolución de run_flow + aviso one-line).

**Why**: El usuario eligió la "Opción 2" (query provider inyectable) para usar su DataSource vivo de TypeORM. GATE 1: (1a) brazo con `type: 'provider'`, (2a) retorno = array completo de filas (yatt corta), (3a) aviso + error i18n para db_assert, (4) ejemplo TypeORM + README.

**Where**: /home/codicore/yatt-ts, HEAD `79fac25` (release v0.2.0) · artefactos en `features/appdb-query-provider/` (brief/context/cases C41-C51/plan/verification).

**Delivery state (2026-09-19)**: GitHub público github.com/josvaal/yatt-ts (main + tags v0.1.0 y v0.2.0, releases de ambas). v0.1.0 quedó congelada pre-provider (a propósito, elección del usuario). v0.2.0 = provider + hardening. **npm publish PENDIENTE del usuario** (`npm login && npm publish` — prepublishOnly corre tests+typecheck+build; nombre yatt-ts libre, tag latest automático en primera publicación).

**Learned**:
- Verificación: 208 unit + 8/8 e2e Chromium real + smoke 133/133 + install-proof con provider desde el tarball.
- Jueces duales encontraron el hallazgo serio del feature: **multi-statement smuggling** (`SELECT 1; DROP` pasaba el regex anclado al inicio; en modo provider el string completo llegaba a la conexión viva del host, mientras engine era inmune por readonly/BEGIN READ ONLY). Fix en capa tool para AMBOS modos: stripper de literales/comentarios + regex de `;` con SQL real detrás. Juez A trazó el guard en sandbox con 23 inputs adversariales: cero bypass, todo fail-closed.
- Strictness aceptada (fail-closed): dollar-quotes, identificadores double-quoted con `;`, E-strings → rechazados aunque sean una sentencia (documentado en JSDoc).
- Patrones reutilizados con éxito: escaneo recursivo con visited-Set (precedente capture_screenshot F7), differential fake-CLI para probar "no spawn", i18n en/es para todo mensaje user-facing.
- Lecciones de Seguridad: (1) regex de seguridad anclado solo al inicio = smuggling de multi-statement; (2) al abrir un camino nuevo (provider in-proceso), la paridad de seguridad con el camino viejo (engine) debe probarse explícitamente, no asumirse.
