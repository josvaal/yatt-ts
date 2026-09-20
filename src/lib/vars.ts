/**
 * Variables, environments, interpolation and datasets (data-driven).
 *
 * Vendored from the base tool's `src/lib/vars.ts` (a pure module with no
 * Tauri imports) so it can be tested in isolation and packed for npm.
 */

export type VarType = 'text' | 'number' | 'option' | 'file';

export const ENV_DEFAULT = 'default';
export const VAR_TYPES: VarType[] = ['text', 'number', 'option', 'file'];

export interface YattVariable {
  name: string;
  type: VarType;
  /** Valid options when type === "option". */
  options?: string[];
  /** Values per environment: key = environment name (or "default"). */
  values: Record<string, string>;
}

export interface Dataset {
  columns: string[];
  rows: Array<Record<string, string>>;
}

export interface ResolvedRun {
  vars: Record<string, string>;
  env: string;
}

/** Substitutes {{name}} with the variable value (when it exists). */
export function interpolate(
  value: string | undefined,
  vars: Record<string, string>,
): string | undefined {
  if (value === undefined) return undefined;
  return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match,
  );
}

export interface StepLike {
  value?: string;
  selector?: string;
  attribute?: string;
}

/** Resolves the interpolable fields of a step (value, selector, attribute). */
export function resolveStep<T extends StepLike>(step: T, vars: Record<string, string>): T {
  return {
    ...step,
    value: interpolate(step.value, vars),
    selector: interpolate(step.selector, vars),
    attribute: interpolate(step.attribute, vars),
  };
}

/**
 * Computes the effective value of every variable for a run:
 * run override ("" = no override) → environment value → default → empty.
 */
export function resolveVars(
  variables: YattVariable[],
  env: string,
  overrides: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of variables) {
    const envVal = v.values?.[env];
    const defVal = v.values?.[ENV_DEFAULT];
    const ov = overrides[v.name];
    out[v.name] = ov !== undefined && ov !== '' ? ov : (envVal ?? defVal ?? '');
  }
  return out;
}

/** Validates a variable value against its type; returns an error or null. */
export function validateVarValue(v: YattVariable, value: string): string | null {
  if (value === undefined || value === null) return null;
  if (v.type === 'number' && value.trim() !== '' && !/^-?\d+([.,]\d+)?$/.test(value.trim())) {
    return 'must be a number';
  }
  if (v.type === 'option' && v.options?.length && !v.options.includes(value)) {
    return 'must be one of the options: ' + v.options.join(', ');
  }
  return null;
}

/** Parses simple CSV (commas + quotes): first row = variable names. */
export function parseCsv(text: string): Dataset {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return { columns: [], rows: [] };

  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQ = false;
          }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQ = true;
      } else if (ch === ',') {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };

  const columns = parseLine(lines[0]).filter(Boolean);
  const rows = lines.slice(1).map((l) => {
    const vals = parseLine(l);
    const row: Record<string, string> = {};
    columns.forEach((c, i) => {
      row[c] = vals[i] ?? '';
    });
    return row;
  });
  return { columns, rows };
}

/** Valid variable name: letters, numbers, underscore, dash and dots only. */
export function validVarName(name: string): boolean {
  return /^[\w.-]+$/.test(name) && !/^\d/.test(name);
}

export function newVariable(name: string, type: VarType = 'text'): YattVariable {
  return { name, type, options: type === 'option' ? [] : undefined, values: { [ENV_DEFAULT]: '' } };
}
