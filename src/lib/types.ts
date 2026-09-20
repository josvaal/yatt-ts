/**
 * Shared type definitions of the YATT test document (schemaVersion 1).
 *
 * Vendored from the base tool's `src/lib/yatt.ts` (types only): that module is
 * Tauri-coupled (it imports Tauri IPC APIs at module scope), so the library
 * carries the pure type definitions instead of importing from it.
 */
import type { Dataset, YattVariable } from './vars.js';

export type StepAction =
  | 'click'
  | 'dblclick'
  | 'hover'
  | 'type'
  | 'clear'
  | 'upload'
  | 'select_option'
  | 'check'
  | 'press_key'
  | 'wait_visible'
  | 'scroll_to_element'
  | 'assert_visible'
  | 'assert_hidden'
  | 'assert_text'
  | 'assert_value'
  | 'assert_attribute'
  | 'goto'
  | 'wait'
  | 'screenshot'
  // Phase 4
  | 'if'
  | 'repeat'
  | 'for_each'
  | 'run_flow'
  | 'open_tab'
  | 'switch_tab'
  | 'close_tab'
  | 'capture_screenshot'
  | 'assert_screenshot';

export interface Step {
  id: string;
  action: StepAction;
  selector?: string;
  value?: string;
  /** Attribute name for assert_attribute. */
  attribute?: string;
  /** Paused step: skipped during serial execution. */
  disabled?: boolean;
  label?: string;
  // ---- Phase 4: conditionals / loops / sub-flows / tabs / visual asserts ----

  /** True branch of `if`, body of `repeat` or `for_each`. */
  children?: Step[];
  /** Alternative branch of `if` (else). */
  elseChildren?: Step[];
  /** How many times the body repeats (repeat). */
  times?: number;
  /** `for_each` list: comma-separated literal, or `{{variable}}`. */
  list?: string;
  /** Variable that takes each item's value inside the loop. */
  itemVar?: string;
  /** Name of the saved test acting as sub-flow (run_flow). */
  flow?: string;
  /** Variable mapping flow var → source in the current test (run_flow). */
  withVars?: Record<string, string>;
  /** Baseline image name under baselines/ (assert/capture_screenshot). */
  baseline?: string;
  /** % of differing pixels allowed (assert_screenshot), default 0. */
  tolerance?: number;
  /** Full-page screenshot (assert/capture_screenshot). */
  fullPage?: boolean;
}

/** Block actions: they carry `children` and are resolved by the runner. */
export const CONTAINER_ACTIONS: StepAction[] = ['if', 'repeat', 'for_each', 'run_flow'];

export function isContainerStep(step: Step): boolean {
  return CONTAINER_ACTIONS.includes(step.action);
}

export interface StepResult {
  ok: boolean;
  error?: string;
  ms?: number;
  screenshot?: string;
}

export interface TestFile {
  schemaVersion: number;
  name: string;
  url: string;
  headless: boolean;
  steps: Step[];
  variables?: YattVariable[];
  envs?: string[];
  dataset?: Dataset;
}
