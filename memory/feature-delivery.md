---
name: Feature delivery yatt-ts-npm-library
description: Resultado del cierre GATE 2 del feature yatt-ts-npm-library (2026-09-19) y cómo re-verificarlo
type: decision
---

# Delivery — yatt-ts-npm-library

**What**: Paquete npm `yatt-ts@0.1.0` completo y verificado: librería que levanta un server MCP de YATT full-configurable (35 tools paridad, engine Playwright headless-first, auth token timing-safe, permisos por tool + readOnly, sesiones con toggle de persistencia, retention opcional, app-db TypeORM-like, CLI `yatt-ts`, i18n en/es, dual-runtime Node≥22.5+Bun).

**Why**: Pedido del usuario (completitud sobre rapidez); 24 decisiones registradas en GATE 1.

**Where**: /home/codicore/yatt-ts (14 commits, HEAD `711a1c6`) · artefactos del feature en `features/yatt-ts-npm-library/` (brief, context, cases C01-C30, plan T1-T13, verification).

**Learned**:
- Verificación: 167 unit + 7/7 e2e Chromium real (`YATT_TS_E2E=1 npx vitest run test/e2e`) + protocol smoke 133/133 (node y bun) + install-proof (`node test/e2e/install.mjs`).
- Review adversarial dual (jd-judge-a/b) encontró 3 bloqueantes reales que los tests NO cubrían (paths custom ignorados por el engine, wipe de app-db en el runner CLI, config de browser muerta en el runner) — arreglados en commit `711a1c6` con regresión e2e cada uno. Los jueces aprobaron en ronda 2.
- El repo base /home/codicore/Proyectos/yatt quedó INTACTO (decisión D15); los fixes de paridad viven solo en yatt-ts.
- Git delivery pendiente del usuario: los commits son locales, nada pusheado, nada publicado a npm.

**Next steps posibles**: publicar a npm (decisión del usuario), sumar Firefox/WebKit, multi-cliente HTTP con aislamiento por sesión (limitación conocida #1 en verification.md).
