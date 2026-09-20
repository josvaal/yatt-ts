/**
 * Meta tools (4): ping, schema, baseline_list, baseline_get. Ported from the
 * base `mcp/src/tools/meta.ts`. Without the engine (sidecar null), ping
 * reports `engine: 'deferred'`; T7/T9 swap in the real check.
 */
import { z } from 'zod';

import { VERSION } from '../../version.js';
import type { YattStrings } from '../../i18n/index.js';
import type { Ctx } from '../ctx.js';
import type { ToolRegistrar } from '../policy-middleware.js';
import { text } from './tests.js';

/** PING timeout of the base tool (15 s). */
const PING_TIMEOUT_MS = 15000;

export function registerMetaTools(reg: ToolRegistrar, ctx: Ctx, strings: YattStrings): void {
  const { store } = ctx;
  const msg = strings.messages;

  reg.register({
    name: 'ping',
    description: strings.tools.ping,
    inputSchema: {},
    mutating: false,
    handler: async () => {
      let engine: 'ready' | 'down' | 'deferred' = 'deferred';
      if (ctx.sidecar) {
        engine = await ctx.sidecar
          .req('ping', {}, PING_TIMEOUT_MS)
          .then(
            () => 'ready' as const,
            () => 'down' as const,
          );
      }
      return text({ ok: true, engine, version: VERSION });
    },
  });

  reg.register({
    name: 'schema',
    description: strings.tools.schema,
    inputSchema: {},
    mutating: false,
    handler: async () => text(strings.schemaDoc),
  });

  reg.register({
    name: 'baseline_list',
    description: strings.tools.baselineList,
    inputSchema: {},
    mutating: false,
    handler: async () => {
      const baselines = store.baselineList();
      return text({ count: baselines.length, baselines });
    },
  });

  reg.register({
    name: 'baseline_get',
    description: strings.tools.baselineGet,
    inputSchema: { name: z.string() },
    mutating: false,
    handler: async (raw) => {
      const { name } = raw as { name: string };
      const png = store.baselineGet(name);
      if (!png) throw new Error(msg.baselineMissing(name));
      return {
        content: [
          { type: 'text' as const, text: `Baseline image: ${name}` },
          { type: 'image' as const, data: toBase64(png), mimeType: 'image/png' },
        ],
      };
    },
  });
}

/** Node equivalent of the base btoa loop: bytes → base64 string. */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
