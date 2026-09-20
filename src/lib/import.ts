/**
 * Validation and normalization of `.yatt.json` test documents.
 *
 * Vendored from the base tool's `src/lib/import.ts` (aliases and Tauri
 * coupling removed). Throws Error with clear messages; the returned document
 * is ready to be stored via `test_create` (step ids guaranteed, including
 * nested ones).
 */
import type { Dataset, YattVariable } from './vars.js';
import type { Step, TestFile } from './types.js';

/** Schema version this library knows how to read/write. */
const CURRENT_SCHEMA_VERSION = 1;

function normalizeStep(raw: unknown, index: number): Step {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`step ${index + 1}: must be an object`);
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.action !== 'string' || s.action.trim() === '') {
    throw new Error(`step ${index + 1}: missing action`);
  }
  const step = s as unknown as Step;
  return {
    ...step,
    id: typeof step.id === 'string' && step.id ? step.id : crypto.randomUUID(),
    action: step.action,
    children: Array.isArray(step.children)
      ? step.children.map((child, i) => normalizeStep(child, i))
      : undefined,
    elseChildren: Array.isArray(step.elseChildren)
      ? step.elseChildren.map((child, i) => normalizeStep(child, i))
      : undefined,
  };
}

function resolveName(docName: unknown, baseName: string): string {
  if (typeof docName === 'string' && docName.trim() && !/[\\/]/.test(docName)) {
    return docName.trim();
  }
  const fromFile = baseName
    .trim()
    .replace(/\.yatt\.json$/i, '')
    .replace(/\.json$/i, '')
    .replace(/[\\/]/g, '')
    .trim();
  return fromFile || 'my-test';
}

function isDataset(raw: unknown): raw is Dataset {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const d = raw as Record<string, unknown>;
  return Array.isArray(d.columns) && Array.isArray(d.rows);
}

/**
 * Validates and normalizes the content of a `.yatt.json` document.
 * Throws Error on any problem; the returned document is ready to be stored
 * (step ids guaranteed, including nested ones).
 */
export function parseImportedTest(content: string, baseName: string): TestFile {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error('the file is not valid JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('the file is not a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  const schemaVersion = obj.schemaVersion;
  if (schemaVersion !== undefined) {
    if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
      throw new Error(`invalid schemaVersion: ${String(schemaVersion)}`);
    }
    if (schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `schemaVersion ${schemaVersion} is not supported (maximum: ${CURRENT_SCHEMA_VERSION})`,
      );
    }
  }
  if (!Array.isArray(obj.steps)) {
    throw new Error('the file has no steps');
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    name: resolveName(obj.name, baseName),
    url: typeof obj.url === 'string' ? obj.url : '',
    headless: obj.headless === true,
    steps: obj.steps.map((step, i) => normalizeStep(step, i)),
    variables: Array.isArray(obj.variables) ? (obj.variables as YattVariable[]) : [],
    envs: Array.isArray(obj.envs) ? obj.envs.filter((e): e is string => typeof e === 'string') : [],
    dataset: isDataset(obj.dataset) ? obj.dataset : undefined,
  };
}
