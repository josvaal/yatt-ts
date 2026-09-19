---
name: YATT base extraction map
description: Mapa de extracción del repo base (Proyectos/yatt) hacia yatt-ts — bloqueantes npm y gotchas
type: discovery
---

# Mapa de extracción YATT → yatt-ts

**What**: Inventario completo en `features/yatt-ts-npm-library/evidence/sdd-explore-report.md` (generado por sdd-explore).

**Learned** (gotchas críticos):
- `mcp/src/db.ts` Store usa `bun:sqlite` hard-import (bloqueante npm); el sidecar SÍ tiene fallback `node:sqlite` (Node ≥22.5) — reusar ese patrón.
- Código base corre TS directo con bun (`allowImportingTsExtensions`, noEmit) → yatt-ts compila de verdad (NodeNext, imports con extensión `.js`).
- `report.ts` importa valor `ACTION_LABELS` desde `yatt.ts` que importa Tauri — al vendorear, copiar el mapa de labels y cortar Tauri.
- `sidecarDir()` resuelve el engine por layout de repo — en yatt-ts el engine va dentro del paquete, resuelto relativo al package.
- `engine.ts` lee `YATT_ROOT` al importar (module-level) → config inyectable explícita, nunca env-at-import.
- `spawnCli` (runner) tiene `bun` hardcodeado sin fallback — bug a corregir en la librería.
- Duplicados a unificar: 2 sanitizers (reject vs replace), 2 generadores de HTML de reporte.
- `browser-install.ts` usa APIs privadas de playwright-core (`registry.install`) — pin de versión y re-verificar en cada bump.
- Invariante sagrado: BD fuente de verdad + espejo de archivos escritos juntos.
- Tests de referencia: `mcp/test/smoke.ts` (~48 checks vía protocolo) y `sidecar/test/smoke.ts` (12 secciones aisladas; demasiada rotación de browsers en una sesión rompe el bus del engine).
