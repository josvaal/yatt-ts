# Plan — in-process app-DB query provider

**Fecha:** 2026-09-19 · Cambio acotado (~450 líneas con tests). Decisiones GATE 1: brazo `type: 'provider'` · retorno `rows[]` completo (yatt corta) · aviso + error claro para db_assert de test_run · ejemplo TypeORM + README incluidos.

**Arquitectura:** el guard read-only, timeout 30s y ROW_CAP ya viven en la capa del tool `db_query` — el provider solo reemplaza a QUIÉN responde la query (`ctx.queryAppDb` pasa de delegar al hijo del engine a ejecutar la función del host en-proceso). Frontera dura documentada: los pasos `db_assert`/`db_wait` de `test_run` corren en el hijo y siguen necesitando sqlite/postgres.

| # | Tarea | Cubre | Test |
|---|---|---|---|
| T1 | Config: brazo `{ type: 'provider', provider }` en `AppDbSchema` (unión discriminada; valida función — C13 nombra la clave); tipos `AppDbProvider`/`ResolvedAppDb` actualizados; `resolveConfig` no intenta resolver nada extra | C48 | `test/unit/config.spec.ts` extendido (provider válido / no-función → error con clave / convive con brazos existentes) |
| T2 | Wiring en `server.ts`: provider → adapter in-proceso de `ctx.queryAppDb`; `YATT_APP_DB_JSON` NO viaja al hijo en modo provider; `serializeAppDb` rechaza el brazo provider con error defensivo claro; aviso one-line (log) al crear el server si `engine.enabled && appDb.type==='provider'` (limitación db_assert) | C41, C46, C51 | specs de T3 + regresión serializeAppDb |
| T3 | Tool `db_query` modo provider: error claro si llega `db` por-llamada (no aplica); mapeo `rows[]` → {columns, rows(≤200), totalRows=filas completas}; timeout 30s existente aplica; mensajes i18n nuevos (en/es): db param, scope db_assert | C41–C47 | `test/unit/appdb-provider.spec.ts`: happy path con espía (SQL exacto), guard read-only sin invocar provider, cap 500→200+totalRows 500, timeout, provider que lanza → server vivo, db param, db_assert en test_run con provider-only → error i18n, engine.enabled:false end-to-end |
| T4 | Docs & packaging: `examples/10-typeorm-provider.ts` (receta NestJS: DataSource vivo → provider; header doc-grade, excluida del typecheck) + README en/es (sección provider + recomendación de rol read-only en la BD) + `test/e2e/install.mjs` monta server con provider desde el tarball y completa db_query | C49, C50 | typecheck de examples (10 excluido) + install.mjs verde |

**Cobertura:** C41→T2/T3 · C42→T3 · C43→T3 · C44→T3 · C45→T3 · C46→T2/T3 · C47→T3 · C48→T1 · C49→T4 · C50→T4 · C51→T2/T3. Todo caso con ≥1 tarea y ≥1 test.

**Orden:** T1 → T2 → T3 (tests primero donde capturen comportamiento nuevo) → T4 → GATE 2.

**Verificación por capa:** unit specs del provider (espías = discriminar qué capa falla) · suite existente = regresión de los modos connection (C51) · install.mjs = consumidor real del tarball · sin UI → sin YATT-in-app (estándar de los features anteriores).
