---
name: yatt-ts GATE 1 decisions
description: Las 24 decisiones del usuario (2026-09-19) que definen el alcance del paquete npm yatt-ts
type: decision
---

# GATE 1 — decisiones del paquete yatt-ts

**What**: Usuario respondió 24 preguntas de clarificación; decisiones registradas verbatim-wrapped en `features/yatt-ts-npm-library/brief.md > Decisiones`.

**Why**: Definen TODO el alcance: nombre, runtime, seguridad, permisos, sesiones, idiomas, distribución.

**Where**: `features/yatt-ts-npm-library/brief.md`; plan en `plan.md` (T1–T13); casos `cases.md` (C01–C30).

**Learned** (las no-obvias):
- Acceso: token con método seguro pedido explícitamente ("con encriptación, busca un método seguro") → hash sha256 + comparación timing-safe, token no se loguea jamás.
- Permisos: AMBOS niveles (readOnly global + allow/deny por tool); tool bloqueada AVISA (no desaparece), `denyBehavior:'hide'` opcional.
- Sesiones sin persistencia = usables en memoria y wiped al cerrar (NO función desactivada).
- Full **headless-first** (headless ON default, capturas siempre), Chromium only, toolbar flotante OFF default.
- app-db: SQLite + Postgres, conexión por **objeto rico estilo TypeORM**, credenciales jamás en argv.
- Docs i18n en/es (en default). Versión 0.1.0. Lista para npm público (no publicar). Git propio día 1 (commits locales OK — autorización explícita del usuario para ESTE repo nuevo).
- Config: solo en código (env/flags solo para el CLI).
- Fix de paridad NO se backportea al repo base (/home/codicore/Proyectos/yatt queda intacto).
