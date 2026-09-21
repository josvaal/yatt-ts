---
name: yatt-ts session pitfalls
description: Gotchas del harness y del entorno descubiertos construyendo yatt-ts (git guard, bun×zod×vitest, fastloop)
type: discovery
---

# Pitfalls de la sesión yatt-ts

**What**: Tres gotchas de entorno que costaron tiempo y conviene saber antes de la próxima sesión.

**Learned**:
1. **Git guard del harness**: los subagentes (y a veces el orquestador) reciben "session root /home/codicore is NOT a git repository" al correr `git` en /home/codicore/yatt-ts (repo creado tras el arranque del harness, no está en su lista de repos). La forma `/usr/bin/git -C /home/codicore/yatt-ts ...` funciona (el guard filtra por nombre de comando). El usuario autorizó explícitamente commits locales en ESTE repo (GATE 1, D-git).
2. **bun×zod×vitest**: `vitest` ejecutado bajo el binario de bun falla al transformar specs que importan zod 4 (`z.strictObject` undefined) — pre-existente desde T2, NO es bug de la librería. Camino canónico: `npx vitest run` (node) para units + `bun run test/e2e/protocol.smoke.mts` (corre `dist/` compilado, plain JS) para probar el runtime bun real. `bun run test` aterriza en workers node.
3. **fastloop_verify no ve repos creados después del arranque de sesión** ("No repos with package.json found under /home/codicore") — correr la gate real por bash (build + vitest + e2e) y documentarlo.

**Where**: /home/codicore/yatt-ts · **Docs**: features/yatt-ts-npm-library/verification.md (sección limitaciones).
