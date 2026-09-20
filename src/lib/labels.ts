/**
 * Human-readable action labels used by report rendering.
 *
 * Vendored verbatim from the base tool's `src/lib/yatt.ts` (that module is
 * Tauri-coupled and must never be imported). The labels are part of the
 * report format shared with the desktop app (D9 compatibility), so they are
 * kept exactly as the base tool renders them.
 */
import type { StepAction } from './types.js';

export const ACTION_LABELS: Record<StepAction, string> = {
  click: 'Click',
  dblclick: 'Doble click',
  hover: 'Hover',
  type: 'Escribir',
  clear: 'Limpiar',
  upload: 'Subir archivo',
  select_option: 'Seleccionar opción',
  check: 'Checkbox',
  press_key: 'Tecla',
  wait_visible: 'Esperar visible',
  scroll_to_element: 'Scroll',
  assert_visible: 'Verificar visible',
  assert_hidden: 'Verificar oculto',
  assert_text: 'Verificar texto',
  assert_value: 'Verificar valor',
  assert_attribute: 'Verificar atributo',
  goto: 'Ir a URL',
  wait: 'Esperar',
  screenshot: 'Captura de pantalla',
  if: 'Si (condición)',
  repeat: 'Repetir',
  for_each: 'Por cada',
  run_flow: 'Sub-flujo',
  open_tab: 'Abrir pestaña',
  switch_tab: 'Cambiar pestaña',
  close_tab: 'Cerrar pestaña',
  capture_screenshot: 'Guardar imagen de referencia',
  assert_screenshot: 'Verificar imagen',
};
