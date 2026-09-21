---
name: Feature delivery nestjs-mcp-http-handler
description: Resultado GATE 2 del feature de integración HTTP externa (NestJS) para yatt-ts (2026-09-19)
type: decision
---

# Delivery — nestjs-mcp-http-handler

**What**: `createMcpHttpHandler(yatt, options?)` — API pública para montar el endpoint MCP de yatt-ts en cualquier ruta de un framework HTTP host (NestJS/Express): ruteo de sesiones extraído del server interno a `src/mcp/http-handler.ts` (única fuente, dos consumidores), receta NestJS en `examples/09` + README en/es, e2e de montaje con express en ruta anidada, install-proof extendido (handler desde el tarball).

**Why**: El usuario preguntó si yatt-ts se puede integrar a NestJS exponiendo el MCP en una ruta; verificada la API (YattServer.start(transport) + handleRequest(req,res,body)), pidió hacerlo oficial ("si, hazlo"). GATE 1: (1a) envuelve YattServer existente, (2a) sin auth default + hook `authenticate`, (3a) receta Nest no-compilada + express como stand-in, (4a) CORS opt-in.

**Where**: /home/codicore/yatt-ts, HEAD `e69f925` · artefactos en `features/nestjs-mcp-http-handler/` (brief/context/cases C31-C40/plan/verification).

**Learned**:
- Verificación: 183 unit + 8/8 e2e Chromium real (incl. handler con engine montado en node:http) + smoke 133/133 (server interno sin cambios) + install-proof con roundtrip del handler desde el tarball.
- Jueces duales: ronda 1 APPROVE con 2 WARNINGs (config.auth ignorado en silencio en modo handler; receta Nest sin enableShutdownHooks) → fix F1-F8 (`7f8c88a`) → re-juzgamiento APPROVE ambos, F1-F8 CONFIRMED_FIXED.
- Descubrimiento valioso: `tsconfig.test.json` NO tenía `exclude` propio → heredaba el del padre y `npm run typecheck` solo chequeaba `src/`. Al arreglarlo se activó el chequeo real (src+test+examples) y destapó 24 errores de tipado latentes, corregidos sin cambios de runtime.
- Decisión de diseño aceptada: `maxBodyBytes` default 2MB en el handler público (safe-by-default), built-in server sin cap (paridad exacta con legacy).
- Aceptados no-bloqueantes: POST body vacío → -32000 (no -32700); evicción new-wins ante cualquier error de connect (diseño pre-existente pinneado por tests F4).
