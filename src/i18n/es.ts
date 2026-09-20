/**
 * Spanish locale (option, D14).
 *
 * Copy ported VERBATIM from the base tool: the 5 prompts (mcp/src/prompts.ts),
 * the SCHEMA_DOC (mcp/src/schema.ts), the tool descriptions (mcp/src/tools/*)
 * and the user-facing messages. Kept identical for parity with the desktop
 * app.
 */
import type { YattStrings } from './index.js';

export const es: YattStrings = {
  locale: 'es',

  schemaDoc: `# Formato de test de YATT (schemaVersion 1)

Un test es un archivo JSON (o objeto) con este contrato:

{
  "schemaVersion": 1,
  "name": "mi-test",            // nombre corto, sin "/", "\\\\" ni ".."
  "url": "https://ejemplo.com", // URL inicial opcional
  "headless": false,
  "steps": [ ... ],             // lista de pasos (ver abajo)
  "variables": [ ... ],         // opcional
  "envs": ["dev", "prod"],      // opcional: entornos de variables
  "dataset": { "columns": ["col"], "rows": [{ "col": "v" }] } // opcional
}

## Pasos (steps)

Cada paso:

{ "id": "uuid opcional (se genera solo)", "action": "<acción>", "selector": "...", "value": "...", "label": "...", "disabled": false }

Acciones de hoja (más usadas):
- goto             ir a una URL            → value = url
- click            clic en un elemento     → selector
- dblclick         doble clic
- hover            pasar el mouse
- type             escribir texto          → selector + value
- clear            limpiar un campo        → selector
- upload           subir archivo           → selector + value (ruta)
- select_option    elegir opción           → selector + value
- check            marcar checkbox/radio   → selector
- press_key        presionar tecla         → value (p. ej. "Enter", "Tab")
- wait_visible     esperar elemento visible → selector
- scroll_to_element  scrollear hasta el elemento → selector
- wait             esperar segundos        → value (número)
- screenshot       capturar pantalla       → selector opcional
- assert_visible   verificar que existe    → selector
- assert_hidden    verificar que no existe → selector
- assert_text      verificar texto         → selector + value (texto esperado)
- assert_value     verificar valor         → selector + value
- assert_attribute verificar atributo      → selector + attribute (nombre) + value (esperado)
- db_assert        verificar contra la base de datos de la app → sql (+ expect: "rows"|"empty"|"value" + value)
- db_wait          esperar un dato en la base de la app        → sql (+ value opcional, timeout, interval)

Acciones de estructura (contenedores con children):
- if        condición: existe el selector (o value con variable) → children (sí) + elseChildren (no)
- repeat    repetir N veces               → times (número) + children
- for_each  recorrer lista                → list ("a,b,c" o "{{variable}}") + itemVar (nombre de variable) + children
- run_flow  ejecutar sub-flujo            → flow (nombre de otro test guardado) + withVars opcional (mapeo)
- open_tab  abrir pestaña                 → value (url)
- switch_tab cambiar de pestaña           → value (índice, 0-based)
- close_tab cerrar pestaña                → value opcional (índice; sin value cierra la activa)
- capture_screenshot  guardar imagen de referencia → value (nombre base) + fullPage opcional
- assert_screenshot   comparar con la imagen base → baseline (nombre) + tolerance (0-100) + fullPage opcional

Reglas:
- Los pasos se ejecutan en orden. Un paso con "disabled": true se salta.
- "label" es una descripción visible (opcional, la genera la app).
- Selectores: data-testid, id o CSS corto; prioridad data-testid → id → CSS único.
- Los sub-flujos (run_flow) deben existir como tests guardados; el runner los
  busca en tests/ y detecta ciclos.

## Variables y entornos

{
  "variables": [
    { "name": "usuario", "type": "text", "values": { "default": "demo", "dev": "demo", "prod": "admin" } }
  ],
  "envs": ["dev", "prod"]
}

- types: "text" | "number" | "option" | "file". Las variables "option" llevan "options": ["a","b"].
- Cualquier "value"/"selector"/"attribute" de un paso admite interpolación {{nombreDeVariable}}.
- Al correr se elige un entorno (default si no se especifica); los overrides por corrida ganan.

## Dataset (data-driven)

{
  "dataset": { "columns": ["usuario", "pass"], "rows": [ { "usuario": "a@x.com", "pass": "123" }, ... ] }
}
Las filas se usan como overrides de variables (una corrida por fila).

## Verificación contra la base de datos

Los pasos db_assert y db_wait consultan la base de datos de la app bajo prueba.
Definí la conexión con la variable de entorno YATT_APP_DB o el flag --app-db del
CLI (ruta de SQLite o URL "file:" / postgres://; la conexión es de solo lectura
y las respuestas se recortan a 200 filas, aunque totalRows cuenta todas).
{ "action": "db_assert", "sql": "SELECT status FROM orders WHERE id = {{orderId}}", "expect": "value", "value": "paid" }
{ "action": "db_wait", "sql": "SELECT status FROM jobs WHERE id = {{jobId}}", "value": "done", "timeout": 15, "interval": 0.5 }

- expect: "rows" (default; exige ≥1 fila) | "empty" (exige 0 filas) | "value" (compara la primera celda, stringificada y recortada, con value).
- db_wait repite la consulta hasta que cumpla (value coincide, o hay filas si no se pasa value) o venza el timeout en segundos (default 10; interval en segundos, default 0.5, mínimo 0.1).
- Guardia de solo lectura: se rechaza toda sentencia que no empiece con SELECT, WITH, EXPLAIN o PRAGMA.

## Guía rápida para la IA

1. Usa test_validate antes de guardar: devuelve errores o el resumen normalizado.
2. Prefiere acciones assert_* al final del test para verificar resultados.
3. Usa {{variable}} en lugar de valores fijos cuando el dato varie por entorno.
4. Tras crear/editar, corre con test_run y lee el reporte (report_get o yatt://reports/<nombre>) para diagnosticar fallos.
5. Para explorar una página usa browser_open + browser_preview (la IA ve el screenshot) + browser_eval para inspeccionar el DOM y elegir selectores robustos.
6. Un flujo que se repite (login, altas, aprobaciones) va como test guardado con variables y se reutiliza con run_flow + withVars; no lo repitas en vivo ciclo tras ciclo.
7. Sesiones: guarda el estado logueado con session_save y reábrelo con session en browser_open para cambiar de usuario sin re-loguear.
8. Múltiples usuarios o combinaciones de datos: variables + dataset (una corrida por fila) u overrides en test_run; no dupliques tests.
9. Espera por condición, no por plazo: wait_visible, un assert o db_wait (datos que escribe en background otro proceso) antes de seguir; wait fijo solo como último recurso.
10. La prueba fuerte de un flujo va con db_assert contra la base de datos; no salgas del navegador a consultar a mano.`,

  prompts: [
    {
      name: 'crear-test',
      description: 'Guía para crear un test YATT desde cero, correrlo y dejarlo verde',
      text: `Vas a crear un test YATT completo. Procedimiento:

1. Lee el recurso yatt://schema (o llama a la tool schema) para conocer el formato exacto y las acciones disponibles.
2. Si necesitás explorar la página bajo prueba: browser_open (url) → browser_preview (podés ver el screenshot) → browser_eval para inspeccionar el DOM y elegir selectores robustos (prioridad: data-testid → id → CSS corto único).
3. Construí el documento de test (schemaVersion 1, steps con acciones goto/click/type/assert_*…).
4. Validalo con test_validate; corregí los errores que devuelva.
5. Guardalo con test_create y corrido con test_run (headless, guarda reporte).
6. Si hay fallos, leé el reporte (report_get o yatt://reports/<slug>.json), mirá el screenshot del paso fallido con el navegador en vivo si hace falta, corregí con test_update y volvé a correr.
7. Terminá solo cuando el reporte dé ok sin fallos.

Reglas: selectores concretos y estables; variables {{nombre}} para datos que varíen por entorno; asserts al final para verificar resultados; nunca inventes URL ni datos que no vengan del usuario.`,
    },
    {
      name: 'diagnosticar-reporte',
      description: 'Analiza un reporte de corrida, encuentra la causa de los fallos y propone correcciones',
      text: `Vas a diagnosticar un reporte de corrida de YATT. Procedimiento:

1. Pedí el nombre del reporte a diagnosticar, o listalos con report_list.
2. Leé el reporte con report_get (o el recurso yatt://reports/<nombre>). Cada paso fallido tiene status "fail", error y ms; los pasos también pueden estar "skipped" o "stopped".
3. Identificá la causa raíz del primer fallo: selector roto, espera insuficiente (agregá wait_visible antes), valor de variable incorrecto, URL caída, o flujo de página distinto.
4. Verificá la hipótesis con el navegador en vivo: browser_open → browser_preview → browser_eval (¿existe el selector? ¿el texto difiere?).
5. Proponé el cambio concreto del paso (selector o valor nuevo) y, si el usuario lo aprueba, aplicalo con test_update.

Formato de respuesta: causa raíz, evidencia (del reporte y del browser), y la corrección exacta propuesta.`,
    },
    {
      name: 'explorar-pagina',
      description: 'Explora una página con el navegador en vivo (screenshots visibles) y produce un mapa de la UI',
      text: `Vas a explorar una página web con el navegador controlado de YATT. Procedimiento:

1. browser_open con la URL (headless por defecto).
2. browser_preview para ver la página; repetí browser_scroll (dy positivo hacia abajo) + browser_preview hasta cubrirla.
3. Usá browser_eval para extraer información útil: texto visible, enlaces (hrefs), inputs (nombres/ids/placeholders), botones, títulos de sección. Ejemplos de expresiones:
   - [...document.querySelectorAll("a")].map(a => [a.textContent.trim(), a.href])
   - [...document.querySelectorAll("input")].map(i => ({type: i.type, name: i.name, id: i.id, ph: i.placeholder}))
   - document.title + location.href
4. Si hay interacción (login, menús), ejecutá pasos con browser_run_step y verificá con browser_condition/browser_preview.
5. Entregá un mapa estructurado: secciones, elementos interactivos con selectores robustos recomendados, y flujos posibles de test.

Regla: no modifiques datos reales; si necesitás escribir en formularios, usá valores de prueba y deja constancia.`,
    },
    {
      name: 'exportar-spec',
      description: 'Exporta un test YATT a código Playwright (spec TypeScript)',
      text: `Vas a exportar un test YATT a código Playwright. Procedimiento:

1. Pedí el nombre del test o listalos con test_list.
2. Llamá a test_export_playwright(name, write: true) para generarlo (también devuelve el contenido).
3. Revisá el spec generado: verifica que los require (npm i -D @playwright/test) estén documentados y que los sub-flujos estén embebidos.
4. Entregá el path del archivo exports/<nombre>.spec.ts y un resumen de qué cubre el spec.`,
    },
    {
      name: 'bateria-de-flujos',
      description:
        'Guía para convertir flujos repetidos en una batería reutilizable: login con variables, sesiones guardadas, sub-flujos y corridas data-driven',
      text: `Vas a convertir los flujos que hoy repetís en vivo (login, altas, aprobaciones, ciclos completos) en una batería de tests reutilizables. Objetivo: grabar una vez, reutilizar cambiando solo los datos.

Regla de oro: si ya repetiste un flujo dos veces en vivo, la tercera va como test guardado. No sigas clickeando lo mismo.

Procedimiento:

1. Identificá los flujos repetidos y qué varía en cada ciclo: usuarios/roles, credenciales, datos de formularios.
2. Grabá el login UNA vez como test con variables {{usuario}} y {{pass}} (nada de credenciales fijas). Elegí selectores robustos con browser_open + browser_preview + browser_eval (data-testid → id → CSS corto único), armá el JSON, validalo con test_validate, guardalo con test_create y dejalo verde con test_run.
3. Guardá la sesión de cada usuario/rol: con el navegador logueado, session_save con nombre claro (ej: "admin", "operador"). En los próximos ciclos abrí con browser_open + session en vez de re-loguear: cambiar de rol es instantáneo y no destruye nada.
4. Partí los flujos largos en sub-flujos guardados (un test por tramo: login, crear trámite, adjuntar, avanzar) y componelos con run_flow + withVars para inyectar los datos de cada ciclo.
5. Lo que varía va en variables, no en tests duplicados: test_run con overrides para una corrida distinta, o test_run_dataset para una corrida por fila (ej: una por usuario).
6. Esperá por condición, no por plazo: wait_visible (o un assert) antes de seguir; wait fijo solo como último recurso y acotado.
7. Corré la batería completa con test_run (headless) y diagnosticá fallos con report_get + el navegador en vivo.

Entrega: tests verdes guardados, sesiones por usuario, y un resumen de qué cubre cada uno. La próxima vez que toque verificar lo mismo, corre test_run: no rehagas los flujos en vivo.`,
    },
  ],

  resources: {
    schema: 'Documentación del formato de test de YATT (esquema v1)',
    test: 'Contenido JSON de un test guardado',
    report: 'Reporte JSON de una corrida (steps con status/error/ms)',
  },

  tools: {
    ping: 'Comprueba que el servidor MCP y el motor (sidecar) responden.',
    schema:
      'Documentación completa del formato de test de YATT (esquema v1): campos, acciones, variables, dataset y guía de uso. Leela antes de crear tests.',
    baselineList: 'Lista las imágenes de referencia guardadas (asserts visuales).',
    baselineGet: 'Devuelve una imagen de referencia como PNG (para comparar visualmente).',
    testList: 'Lista los tests guardados en la biblioteca de YATT (nombres).',
    testGet:
      'Obtiene un test guardado como objeto JSON completo (steps, variables, entornos, dataset).',
    testCreate:
      'Crea un test nuevo. Acepta el contenido como string JSON o como objeto. Valida el esquema (schemaVersion, steps, acciones). Falla si el nombre ya existe salvo overwrite: true.',
    testUpdate:
      'Reemplaza el contenido completo de un test existente (misma validación que test_create).',
    testDelete:
      'Borra un test de la biblioteca (base de datos y archivo tests/<nombre>.yatt.json).',
    testRename: 'Renombra un test en la biblioteca (actualiza BD y archivo espejo).',
    testDuplicate: 'Duplica un test existente con un nombre nuevo (default "<nombre> (copia)").',
    testValidate:
      'Valida contenido de test (string JSON u objeto) sin guardarlo. Devuelve {ok: true, doc: resumen} o {ok: false, error}. Útil antes de test_create/test_update.',
    testExport:
      'Genera el código de un test guardado como spec TypeScript (.spec.ts), en formato Playwright (@playwright/test) o Jest (jest-environment-playwright), con sub-flujos embebidos como funciones. Devuelve el contenido; con write: true lo guarda en exports/<nombre>.spec.ts como la app.',
    reportList: 'Lista los reportes de corrida guardados (nombres <slug>.json y <slug>.html).',
    reportGet:
      'Devuelve el contenido de un reporte (JSON analizable). Para diagnosticar fallos, el reporte tiene steps[] con status ok/fail, error y ms.',
    reportDelete: 'Borra un reporte guardado (BD + archivo en reports/).',
    dbQuery:
      'Ejecuta una consulta de solo lectura (SELECT/WITH/EXPLAIN/PRAGMA) contra la base de datos de la app bajo prueba. Pasá la conexión en `db` (ruta de SQLite o URL "file:" / postgres://); si no, se usa la configuración YATT_APP_DB/--app-db del motor. Devuelve {columns, rows, totalRows}; las filas se recortan a 200.',
    testRun:
      'Corre un test guardado en headless (motor Chromium por defecto) y guarda un reporte en la biblioteca. Parámetros: entorno de variables, overrides por corrida, timeout por paso. Devuelve el resumen con los pasos y el nombre del reporte.',
    testRunDataset:
      'Data-driven: corre un test una vez por fila de overrides y devuelve el resultado de cada fila más totales. No guarda reporte.',
    browserOpen:
      'Abre (o reabre) el navegador controlado. headless=true por defecto; visible solo si hace falta apuntar con la mano.',
    browserClose: 'Cierra el navegador controlado (limpia la sesión del browser).',
    browserStatus:
      'Estado del navegador controlado: abierto/cerrado, motor, URL e interacción.',
    browserPreview:
      'Captura del viewport actual como imagen PNG (la IA ve la página) + url, título, scroll y dimensiones. Es la herramienta principal de inspección visual.',
    browserEval:
      'Ejecuta JavaScript arbitrario en la página actual y devuelve el valor (útil para inspeccionar el DOM, leer textos, contar elementos, probar selectores).',
    browserRunStep:
      'Ejecuta un paso YATT (hoja) en la página actual: click, type, hover, assert_*, goto, wait_visible, etc. Devuelve ok/error, duración y, si falla, un screenshot de evidencia. Con `vars` interpola {{nombre}} en el paso antes de ejecutarlo. Pasos de estructura (if/repeat/for_each/run_flow) se corren con test_run, no aquí.',
    browserCondition:
      'Comprueba si existe un elemento en la página (o si se cumple una condición de variable); espera por condición con polling opcional (timeoutMs > 0 repite el chequeo hasta que sea verdadero o venza el timeout). Devuelve {value, elapsedMs}.',
    browserScroll:
      'Desplaza la página verticalmente (dy en píxeles, positivo hacia abajo) y devuelve la preview actualizada.',
    browserClickAt:
      'Clic en coordenadas del viewport (x, y en píxeles CSS); devuelve el selector resuelto del elemento clickeado (data-testid → id → path CSS) más la preview actualizada. Preferí browser_run_step con selector para pasos reproducibles.',
    tabOpen: 'Abre una pestaña nueva (opcionalmente con URL) y devuelve la lista de pestañas.',
    tabList: 'Lista las pestañas abiertas: índice, activa, título y URL.',
    tabSwitch: 'Cambia a la pestaña con el índice dado (0-based).',
    tabClose: 'Cierra una pestaña (por índice; sin índice cierra la activa).',
    sessionSave:
      'Guarda el estado de sesión actual (cookies/localStorage) con un nombre, para tests con autenticación previa.',
    sessionList: 'Lista las sesiones guardadas.',
    sessionDelete: 'Borra una sesión guardada.',
  },

  args: {
    testName: 'Nombre del test guardado',
    nameToUpdate: 'Nombre del test a reemplazar',
    newName: 'Nuevo nombre',
    content: 'Contenido del test: string JSON u objeto',
    overwrite: 'Sobrescribir si ya existe (default false)',
    suggestedName: 'Nombre sugerido (opcional)',
    format: 'Formato del spec generado (default "playwright")',
    write: 'Escribir el archivo en exports/ (default false)',
    reportName:
      'Nombre del reporte (ver report_list, p. ej. "mi-test-YATT-20260902-101500.json")',
    sql: 'Consulta SQL de solo lectura (SELECT, WITH, EXPLAIN o PRAGMA)',
    db: "Conexión: ruta de SQLite o URL 'file:' / postgres:// (gana sobre la config global)",
    runName: 'Nombre del test guardado',
    env: 'Entorno de variables (default "default")',
    overrides: 'Valores de variables que ganan sobre el entorno',
    stepTimeoutMs: 'Timeout por paso en ms (default 40000)',
    browser: 'Motor (default chromium)',
    url: 'Sobrescribe la URL inicial',
    saveReport: 'Guardar reporte en la biblioteca (default true)',
    rows: 'Lista de filas; una corrida por fila (valores = overrides de variables)',
    openUrl: 'URL inicial (default about:blank)',
    headless: 'Modo sin ventana (default true)',
    viewport: 'Tamaño del viewport (default 1280×800)',
    session:
      'Nombre de una sesión guardada (cookies/localStorage). Con sessions.persist:false el estado se restaura inline desde memoria',
    expression: 'Expresión JS (se evalúa con el resultado devuelto)',
    runStepTimeoutMs: 'Timeout en ms (default 40000)',
    vars:
      'Variables para interpolar {{nombre}} en el paso (p. ej. { "email": "a@b.com" })',
    conditionSelector: 'Selector del elemento a comprobar',
    conditionValue:
      'Alternativa: condición de variable (p. ej. {{estado}} == ok)',
    conditionTimeoutMs:
      'Si es > 0, polling hasta que la condición sea verdadera o venza (default 0 = un solo chequeo)',
    intervalMs: 'Intervalo entre chequeos en ms (default 300)',
    scrollDy: 'Píxeles a desplazar',
    clickX: 'Coordenada X (píxeles CSS)',
    clickY: 'Coordenada Y (píxeles CSS)',
    tabIndex: 'Índice de la pestaña (ver tab_list)',
    tabUrl: 'URL inicial de la pestaña nueva',
    sessionName: 'Nombre de la sesión',
  },

  messages: {
    testDoesNotExist: (name) => `el test "${name}" no existe`,
    testAlreadyExists: (name) => `el test "${name}" ya existe (usá test_update o overwrite: true)`,
    testMissingCreate: (name) => `el test "${name}" no existe (usá test_create)`,
    testNameTaken: (name) => `ya existe un test llamado "${name}"`,
    reportMissingGet: (name) => `el reporte "${name}" no existe (usá report_list)`,
    reportMissingDelete: (name) => `el reporte "${name}" no existe`,
    baselineMissing: (name) => `la imagen base "${name}" no existe`,
    subFlowMissing: (name) => `el sub-flujo "${name}" no existe en la biblioteca`,
    datasetSummary: (rows, columns) => `${rows} filas × ${columns} columnas`,
    duplicateSuffix: '(copia)',
    dbReadOnly: () => 'db: solo lectura (SELECT/WITH/EXPLAIN/PRAGMA)',
    dbEngineRequired:
      'la consulta a la base de la app requiere el motor, no disponible en esta configuración del servidor',
    dbQueryTimeout: (timeoutMs) => `db: la consulta excedió el tiempo de espera (${timeoutMs} ms)`,
    runTestMissing: (name) => `el test "${name}" no está guardado (crealo con test_create primero)`,
    runFailedNoReport: (tail) => `la corrida falló sin reporte: ${tail}`,
    engineRequired:
      'esta herramienta requiere el motor, no disponible en esta configuración del servidor (engine.enabled: false)',
    stepMustHaveAction: 'step debe ser un objeto con action',
  },
};
