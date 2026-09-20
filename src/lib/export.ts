/**
 * Export of a YATT test to Playwright or Jest code (RF-24).
 *
 * Generates a linear, readable TypeScript spec: each step is emitted as its
 * real statement (`await page.locator(...).click()`), if/repeat/for_each/
 * run_flow blocks as native control flow and sub-flows (RF-21) as named
 * functions. It is a solid starting point for CI: it can be tweaked by hand.
 *
 * Formats:
 * - "playwright": official test runner (@playwright/test).
 * - "jest": Jest + jest-environment-playwright (page/browser globals).
 */

import type { Step, TestFile } from './types.js';
import { ENV_DEFAULT, resolveVars } from './vars.js';

export type ExportFormat = 'playwright' | 'jest';

const js = (s: string) => JSON.stringify(s);

/** Sanitizes a name into a safe TS identifier for sub-flow functions. */
const flowFn = (name: string) =>
  'flow_' + (name || 'flow').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();

/** Normalizes a baseline/screenshot name. */
const shotName = (s: Step) =>
  ((s.baseline ?? s.value ?? '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-') || 'screenshot');

/** Line emitter with indentation. */
class Writer {
  private out: string[] = [];
  private depth = 0;
  push(line = '') {
    this.out.push(line.length ? '  '.repeat(this.depth) + line : '');
  }
  indent(fn: () => void) {
    this.depth++;
    fn();
    this.depth--;
  }
  text() {
    return this.out.join('\n');
  }
}

interface GenCtx {
  format: ExportFormat;
  /** Active vars expression in the emission scope ("VARS" or "vars"). */
  varsExpr: string;
  /** Active page ("page" or "pg" when the test uses tabs). */
  page: string;
  /** Test URL (fallback for goto without value). */
  url: string;
}

/** Literal expression for a value with `{{var}}` resolved at runtime. */
function valExpr(raw: string | undefined, ctx: GenCtx): string {
  if (raw === undefined) return 'undefined';
  const lit = js(raw);
  return /\{\{[\w.-]+\}\}/.test(raw) ? `t(${lit}, ${ctx.varsExpr})` : lit;
}

/** Like valExpr, but with a literal fallback when the value is missing (avoids unreachable `x ?? y`). */
function valExprOr(raw: string | undefined, fallback: string, ctx: GenCtx): string {
  return raw === undefined ? js(fallback) : valExpr(raw, ctx);
}

/** Emits the statements of a step (leaf or block) to the writer. */
function emitStep(w: Writer, s: Step, ctx: GenCtx) {
  const pg = ctx.page;
  const sel = () => valExpr(s.selector, ctx);
  const loc = () => `${pg}.locator(${sel()})`;
  const comment = s.label ? `// ${s.label}\n` : '';
  const emit = (line: string) => {
    if (comment) w.push();
    w.push(line);
  };

  switch (s.action) {
    case 'if': {
      if (comment) w.push();
      w.push(`{`);
      w.indent(() => {
        if (s.selector) {
          w.push(`const cond = (await ${pg}.locator(${sel()}).count()) > 0;`);
        } else {
          w.push(`const cond = !!${valExpr(s.value, ctx)} && ${valExpr(s.value, ctx)} !== "false" && ${valExpr(s.value, ctx)} !== "0";`);
        }
        w.push(`if (cond) {`);
        w.indent(() => emitSteps(w, s.children ?? [], ctx));
        if ((s.elseChildren ?? []).length > 0) {
          w.push(`} else {`);
          w.indent(() => emitSteps(w, s.elseChildren ?? [], ctx));
        }
        w.push(`}`);
      });
      w.push(`}`);
      break;
    }
    case 'repeat': {
      if (comment) w.push();
      w.push(`{`);
      w.indent(() => {
        w.push(`const times = Math.max(0, Math.floor(Number(${valExpr(s.times != null ? String(s.times) : undefined, ctx)}) || 0));`);
        w.push(`for (let i = 0; i < times; i++) {`);
        w.indent(() => emitSteps(w, s.children ?? [], ctx));
        w.push(`}`);
      });
      w.push(`}`);
      break;
    }
    case 'for_each': {
      if (comment) w.push();
      const itemVar = s.itemVar || 'item';
      w.push(`{`);
      w.indent(() => {
        w.push(`const items = ${valExprOr(s.list, '', ctx)}.split(",").map((x) => x.trim()).filter(Boolean);`);
        w.push(`for (const ${itemVar} of items) {`);
        w.indent(() => {
          w.push(`const vars = { ...${ctx.varsExpr}, ${js(itemVar)}: ${itemVar} };`);
          emitSteps(w, s.children ?? [], { ...ctx, varsExpr: 'vars' });
        });
        w.push(`}`);
      });
      w.push(`}`);
      break;
    }
    case 'run_flow': {
      if (comment) w.push();
      const fn = flowFn(s.flow ?? '');
      const withVars = Object.entries(s.withVars ?? {});
      if (withVars.length === 0) {
        emit(`await ${fn}(${pg}, ${ctx.varsExpr});`);
      } else {
        w.push(`{`);
        w.indent(() => {
          w.push(`const vars = { ...${ctx.varsExpr} };`);
          for (const [k, src] of withVars) {
            const exact = /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(src ?? '');
            w.push(`vars[${js(k)}] = ${exact ? `${ctx.varsExpr}[${js(exact[1])}]` : valExpr(src, ctx)};`);
          }
          w.push(`await ${fn}(${pg}, vars);`);
        });
        w.push(`}`);
      }
      break;
    }
    case 'open_tab':
      emit(`${pg} = await ${pg}.context().newPage();`);
      if (s.value) emit(`await ${pg}.goto(${valExpr(s.value, ctx)}, { waitUntil: "domcontentloaded" });`);
      break;
    case 'switch_tab':
      emit(`${pg} = ${pg}.context().pages()[Number(${valExpr(s.value, ctx)})];`);
      break;
    case 'close_tab': {
      if (comment) w.push();
      w.push(`{`);
      w.indent(() => {
        w.push(`const pages = ${pg}.context().pages();`);
        w.push(`const idx = ${s.value === undefined || s.value === '' ? `pages.indexOf(${pg})` : `Number(${valExpr(s.value, ctx)})`};`);
        w.push(`const closing = pages[idx];`);
        w.push(`if (closing === ${pg}) ${pg} = pages.filter((x) => x !== closing)[pages.length - 2];`);
        w.push(`await closing.close();`);
      });
      w.push(`}`);
      break;
    }
    case 'capture_screenshot':
      emit(`await ${pg}.screenshot({ path: "baselines/${shotName(s)}.png", fullPage: ${!!s.fullPage} });`);
      break;
    case 'assert_screenshot':
      if (ctx.format === 'playwright') {
        emit(`await expect(${pg}).toHaveScreenshot("${shotName(s)}.png", { maxDiffPixelRatio: ${Math.max(0, Number(s.tolerance) || 0) / 100}, fullPage: ${!!s.fullPage} });`);
      } else {
        // toHaveScreenshot belongs to @playwright/test; under Jest the screenshot
        // is saved and the visual comparison remains manual work.
        emit(`// Visual assert omitted: toHaveScreenshot requires @playwright/test.`);
        emit(`await ${pg}.screenshot({ path: "baselines/${shotName(s)}.png", fullPage: ${!!s.fullPage} });`);
      }
      break;
    default: {
      const lines: string[] = [];
      switch (s.action) {
        case 'click': lines.push(`await ${loc()}.click({ timeout: 5000 });`); break;
        case 'dblclick': lines.push(`await ${loc()}.dblclick({ timeout: 5000 });`); break;
        case 'hover': lines.push(`await ${loc()}.hover({ timeout: 5000 });`); break;
        case 'type': lines.push(`await ${loc()}.fill(${valExpr(s.value, ctx)}, { timeout: 5000 });`); break;
        case 'clear': lines.push(`await ${loc()}.clear({ timeout: 5000 });`); break;
        case 'upload': lines.push(`await ${loc()}.setInputFiles(${valExprOr(s.value, '', ctx)}, { timeout: 5000 });`); break;
        case 'select_option': lines.push(`await ${loc()}.selectOption(${valExpr(s.value, ctx)});`); break;
        case 'check': lines.push(`await ${loc()}.check({ timeout: 5000 });`); break;
        case 'press_key':
          if (s.selector) lines.push(`await ${loc()}.press(${valExpr(s.value, ctx) === 'undefined' ? `"Enter"` : valExpr(s.value, ctx)}, { timeout: 5000 });`);
          else lines.push(`await ${pg}.keyboard.press(${valExpr(s.value, ctx) === 'undefined' ? `"Enter"` : valExpr(s.value, ctx)});`);
          break;
        case 'wait_visible': lines.push(`await ${loc()}.waitFor({ state: "visible", timeout: 10000 });`); break;
        case 'scroll_to_element': lines.push(`await ${loc()}.scrollIntoViewIfNeeded();`); break;
        case 'assert_visible': lines.push(`await expect(${loc()}).toBeVisible();`); break;
        case 'assert_hidden': lines.push(`await expect(${loc()}).toBeHidden();`); break;
        case 'assert_text': lines.push(`await expect(${loc()}).toContainText(${valExpr(s.value, ctx)});`); break;
        case 'assert_value': lines.push(`await expect(${loc()}).toHaveValue(${valExpr(s.value, ctx)});`); break;
        case 'assert_attribute': lines.push(`await expect(${loc()}).toHaveAttribute(${valExpr(s.attribute, ctx)}, ${valExpr(s.value, ctx)});`); break;
        case 'goto': lines.push(`await ${pg}.goto(${valExprOr(s.value, ctx.url, ctx)}, { waitUntil: "domcontentloaded", timeout: 30000 });`); break;
        case 'wait': lines.push(`await ${pg}.waitForTimeout(Math.max(0, Number(${valExpr(s.value, ctx)}) || 500));`); break;
        case 'screenshot': lines.push(`await ${pg}.screenshot({ type: "png" });`); break;
        default:
          throw new Error(`action not supported in the export: ${s.action}`);
      }
      if (comment) w.push();
      for (const l of lines) w.push(l);
    }
  }
}

/** Emits a sequence of steps. */
function emitSteps(w: Writer, steps: Step[], ctx: GenCtx) {
  for (const s of steps) emitStep(w, s, ctx);
}

/** Collects sub-flows (RF-21) with cycle detection. Returns name → steps. */
async function collectFlows(
  doc: TestFile,
  loadFlow: (name: string) => Promise<string>,
): Promise<Record<string, Step[]>> {
  const flows: Record<string, Step[]> = {};
  const loaded = new Set<string>();
  const pending = new Set<string>();
  const queue: string[] = [];

  const enqueue = (steps: Step[], from: string) => {
    for (const s of steps) {
      if (s.action !== 'run_flow' || !s.flow) continue;
      if (loaded.has(s.flow)) continue;
      if (pending.has(s.flow)) throw new Error(`circular sub-flow in the export: ${from} → ${s.flow}`);
      queue.push(s.flow);
      enqueue(s.children ?? [], s.flow);
    }
  };

  enqueue(doc.steps ?? [], doc.name || 'root');
  for (let i = 0; i < queue.length; i++) {
    const name = queue[i];
    if (loaded.has(name)) continue;
    pending.add(name);
    const fdoc = JSON.parse(await loadFlow(name)) as TestFile;
    loaded.add(name);
    pending.delete(name);
    flows[name] = fdoc.steps ?? [];
    enqueue(fdoc.steps ?? [], name);
  }
  return flows;
}

/** True when the step tree uses tabs (open/switch/close_tab). */
function usesTabs(steps: Step[]): boolean {
  return steps.some(
    (s) =>
      s.action === 'open_tab' || s.action === 'switch_tab' || s.action === 'close_tab' ||
      usesTabs(s.children ?? []) || usesTabs(s.elseChildren ?? []),
  );
}

/** Registers the sub-flows as functions with their steps, in dependency order. */
function emitFlowFunctions(w: Writer, flows: Record<string, Step[]>, ctx: GenCtx) {
  for (const [name, steps] of Object.entries(flows)) {
    w.push(`/** Sub-flow "${name}" (embedded from the YATT library). */`);
    w.push(`async function ${flowFn(name)}(${ctx.page}: Page, vars: Record<string, string> = VARS): Promise<void> {`);
    w.indent(() => emitSteps(w, steps, { ...ctx, varsExpr: 'vars' }));
    w.push(`}`);
    w.push();
  }
}

/**
 * Generates the TypeScript spec (linear format) for the test and its
 * sub-flows.
 */
export async function buildSpec(
  doc: TestFile,
  loadFlow: (name: string) => Promise<string>,
  format: ExportFormat = 'playwright',
): Promise<string> {
  const flows = await collectFlows(doc, loadFlow);
  const hasTabs = usesTabs(doc.steps ?? []) || Object.values(flows).some((f) => usesTabs(f));
  const pg = hasTabs ? 'pg' : 'page';
  const url = doc.url || 'about:blank';
  const ctx: GenCtx = { format, varsExpr: 'VARS', page: pg, url };

  const testTitle = `${doc.name || 'my-test'} (exported from YATT)`;
  const vars = resolveVars(doc.variables ?? [], ENV_DEFAULT, {});

  const body = new Writer();
  if (hasTabs) body.push(`let pg: Page = page;`);
  body.push(`await ${pg}.goto(${js(url)}, { waitUntil: "domcontentloaded", timeout: 30000 });`);
  emitSteps(body, doc.steps ?? [], ctx);

  const flowsW = new Writer();
  emitFlowFunctions(flowsW, flows, ctx);
  const flowsCode = flowsW.text();

  if (format === 'jest') {
    return `// Generated by YATT (RF-24). Target: Jest + jest-environment-playwright.
// Requires: npm i -D jest jest-environment-playwright
// and in jest.config: testEnvironment: "jest-environment-playwright".
import { describe, expect, it } from "@jest/globals";
import type { Page } from "playwright";

declare const page: Page;

// Test variables with their default values (YATT default environment).
const VARS: Record<string, string> = ${JSON.stringify(vars, null, 2)};

// Interpolates {{variable}} with the values of VARS (or the received scope).
function t(value: string, vars?: Record<string, string>): string;
function t(value: string | undefined, vars?: Record<string, string>): string | undefined;
function t(value: string | undefined, vars: Record<string, string> = VARS): string | undefined {
  if (value === undefined) return undefined;
  return String(value).replace(/\\{\\{\\s*([\\w.-]+)\\s*\\}\\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m,
  );
}

${flowsCode}describe(${js(doc.name || 'my-test')}, () => {
  it(${js(testTitle)}, async () => {
${body
  .text()
  .split('\n')
  .map((l) => (l ? '    ' + l : l))
  .join('\n')}
  });
});
`;
  }

  return `// Generated by YATT (RF-24). Requires: npm i -D @playwright/test && npx playwright install chromium
import { test, expect, type Page } from "@playwright/test";

// Test variables with their default values (YATT default environment).
const VARS: Record<string, string> = ${JSON.stringify(vars, null, 2)};

// Interpolates {{variable}} with the values of VARS (or the received scope).
function t(value: string, vars?: Record<string, string>): string;
function t(value: string | undefined, vars?: Record<string, string>): string | undefined;
function t(value: string | undefined, vars: Record<string, string> = VARS): string | undefined {
  if (value === undefined) return undefined;
  return String(value).replace(/\\{\\{\\s*([\\w.-]+)\\s*\\}\\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m,
  );
}

${flowsCode}test(${js(testTitle)}, async ({ page }) => {
${body
  .text()
  .split('\n')
  .map((l) => (l ? '  ' + l : l))
  .join('\n')}
});
`;
}
