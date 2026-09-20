/**
 * Test library tools (9): CRUD + rename/duplicate + validation + Playwright
 * export. Ported from the base `mcp/src/tools/tests.ts` — same names, same
 * zod input schemas, same envelopes; copy comes from the i18n module and the
 * policy metadata (`mutating`) is declared per tool.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

import { buildSpec, type ExportFormat } from '../../lib/export.js';
import { parseImportedTest } from '../../lib/import.js';
import type { TestFile } from '../../lib/types.js';
import { Store } from '../../store/index.js';
import type { Ctx } from '../ctx.js';
import { PolicyDeniedError } from '../policy-middleware.js';
import type { YattStrings } from '../../i18n/index.js';
import type { ToolRegistrar } from '../policy-middleware.js';

/** Accepts the content of a test as a JSON string or as an object. */
const contentSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);

export function coerceOverrides(v: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v ?? {})) {
    out[k] = val === undefined || val === null ? '' : String(val);
  }
  return out;
}

/** Converts a tool argument (JSON string or object) into a validated TestFile. */
export function toDoc(content: unknown, name?: string): TestFile {
  const raw = typeof content === 'string' ? content : JSON.stringify(content ?? null);
  const doc = parseImportedTest(raw, name ?? 'test');
  if (name) doc.name = name;
  return doc;
}

export function docSummary(doc: TestFile, strings: YattStrings): Record<string, unknown> {
  return {
    name: doc.name,
    url: doc.url,
    headless: doc.headless,
    steps: doc.steps.length,
    variables: (doc.variables ?? []).length,
    envs: doc.envs ?? [],
    dataset: doc.dataset
      ? strings.messages.datasetSummary(doc.dataset.rows.length, doc.dataset.columns.length)
      : null,
  };
}

export function text(parts: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof parts === 'string' ? parts : JSON.stringify(parts, null, 2),
      },
    ],
  };
}

export function registerTestTools(reg: ToolRegistrar, ctx: Ctx, strings: YattStrings): void {
  const { store } = ctx;
  const msg = strings.messages;
  const args = strings.args;
  const nameArg = z.string().describe(args.testName);

  reg.register({
    name: 'test_list',
    description: strings.tools.testList,
    inputSchema: {},
    mutating: false,
    handler: async () => {
      const tests = store.testList();
      return text({ count: tests.length, tests });
    },
  });

  reg.register({
    name: 'test_get',
    description: strings.tools.testGet,
    inputSchema: { name: nameArg },
    mutating: false,
    handler: async (raw) => {
      const { name } = raw as { name: string };
      const safe = Store.sanitizeName(name);
      const content = store.testGet(safe);
      if (content === null) throw new Error(msg.testDoesNotExist(safe));
      return text({ name: safe, doc: JSON.parse(content) });
    },
  });

  reg.register({
    name: 'test_create',
    description: strings.tools.testCreate,
    inputSchema: {
      content: contentSchema.describe(args.content),
      name: z.string().optional().describe(args.testName),
      overwrite: z.boolean().optional().describe(args.overwrite),
    },
    mutating: true,
    handler: async (raw) => {
      const a = raw as { content: unknown; name?: string; overwrite?: boolean };
      const doc = toDoc(a.content, a.name);
      if (store.testExists(doc.name) && !a.overwrite) {
        throw new Error(msg.testAlreadyExists(doc.name));
      }
      const json = JSON.stringify(doc, null, 2);
      await store.upsertTest(doc.name, json);
      return text({ ok: true, created: doc.name, ...docSummary(doc, strings) });
    },
  });

  reg.register({
    name: 'test_update',
    description: strings.tools.testUpdate,
    inputSchema: {
      name: nameArg.describe(args.nameToUpdate),
      content: contentSchema.describe(args.content),
    },
    mutating: true,
    handler: async (raw) => {
      const a = raw as { name: string; content: unknown };
      const name = Store.sanitizeName(a.name);
      if (!store.testExists(name)) throw new Error(msg.testMissingCreate(name));
      const doc = toDoc(a.content, name);
      await store.upsertTest(name, JSON.stringify(doc, null, 2));
      return text({ ok: true, updated: name, ...docSummary(doc, strings) });
    },
  });

  reg.register({
    name: 'test_delete',
    description: strings.tools.testDelete,
    inputSchema: { name: nameArg },
    mutating: true,
    handler: async (raw) => {
      const { name } = raw as { name: string };
      const safe = Store.sanitizeName(name);
      if (!store.testExists(safe)) throw new Error(msg.testDoesNotExist(safe));
      await store.deleteTest(safe);
      return text({ ok: true, deleted: safe });
    },
  });

  reg.register({
    name: 'test_rename',
    description: strings.tools.testRename,
    inputSchema: {
      name: nameArg.describe(args.testName),
      newName: z.string().describe(args.newName),
    },
    mutating: true,
    handler: async (raw) => {
      const a = raw as { name: string; newName: string };
      const name = Store.sanitizeName(a.name);
      const newName = Store.sanitizeName(a.newName);
      if (name === newName) return text({ ok: true, renamed: name });
      if (store.testExists(newName)) throw new Error(msg.testNameTaken(newName));
      const content = store.testGet(name);
      if (content === null) throw new Error(msg.testDoesNotExist(name));
      const doc = JSON.parse(content) as TestFile;
      doc.name = newName;
      await store.upsertTest(newName, JSON.stringify(doc, null, 2));
      await store.deleteTest(name);
      return text({ ok: true, renamed: newName });
    },
  });

  reg.register({
    name: 'test_duplicate',
    description: strings.tools.testDuplicate,
    inputSchema: {
      name: nameArg,
      newName: z.string().optional().describe(args.newName),
    },
    mutating: true,
    handler: async (raw) => {
      const a = raw as { name: string; newName?: string };
      const name = Store.sanitizeName(a.name);
      const content = store.testGet(name);
      if (content === null) throw new Error(msg.testDoesNotExist(name));
      const newName = a.newName ? Store.sanitizeName(a.newName) : `${name} ${msg.duplicateSuffix}`;
      if (store.testExists(newName)) throw new Error(msg.testNameTaken(newName));
      const doc = JSON.parse(content) as TestFile;
      doc.name = newName;
      await store.upsertTest(newName, JSON.stringify(doc, null, 2));
      return text({ ok: true, duplicated: newName });
    },
  });

  reg.register({
    name: 'test_validate',
    description: strings.tools.testValidate,
    inputSchema: {
      content: contentSchema.describe(args.content),
      name: z.string().optional().describe(args.suggestedName),
    },
    mutating: false,
    handler: async (raw) => {
      const a = raw as { content: unknown; name?: string };
      try {
        const doc = toDoc(a.content, a.name);
        return text({ ok: true, doc: docSummary(doc, strings) });
      } catch (err) {
        return text({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  reg.register({
    name: 'test_export_playwright',
    description: strings.tools.testExport,
    inputSchema: {
      name: nameArg,
      format: z.enum(['playwright', 'jest']).optional().describe(args.format),
      write: z.boolean().optional().describe(args.write),
    },
    mutating: false,
    handler: async (raw) => {
      const a = raw as { name: string; format?: ExportFormat; write?: boolean };
      const name = Store.sanitizeName(a.name);
      const format: ExportFormat = a.format ?? 'playwright';
      const content = store.testGet(name);
      if (content === null) throw new Error(msg.testDoesNotExist(name));
      const doc = JSON.parse(content) as TestFile;
      const loadFlow = async (flowName: string): Promise<string> => {
        const flowRaw = store.testGet(flowName);
        if (flowRaw === null) throw new Error(msg.subFlowMissing(flowName));
        return flowRaw;
      };
      const spec = await buildSpec(doc, loadFlow, format);
      let path: string | null = null;
      // F7 (D6): `write: true` lands a file in the exports dir — a write path
      // the tool's `mutating: false` label hides. Read-only mode announces the
      // denial instead of silently leaking the write.
      if (a.write && ctx.policy.readOnly) {
        throw new PolicyDeniedError(
          "tool 'test_export_playwright' writes a spec file and this server runs in read-only mode",
        );
      }
      if (a.write) {
        const dir = ctx.config.paths.exports;
        mkdirSync(dir, { recursive: true });
        path = join(dir, `${name}.spec.ts`);
        writeFileSync(path, spec, 'utf8');
      }
      return text({ ok: true, name, length: spec.length, path, spec });
    },
  });
}
