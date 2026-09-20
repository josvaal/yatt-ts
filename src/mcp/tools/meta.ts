/**
 * Meta tools (4): ping, schema, baseline_list, baseline_get. Ported from the
 * base `mcp/src/tools/meta.ts`. With the engine enabled, ping performs the
 * real check (req('ping'), 15 s timeout): `{ok:true, engine:'ready'}` or
 * `{ok:false, engine:'unavailable'}`; with `engine.enabled: false` it reports
 * `engine: 'deferred'`.
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
      // Engine check (T7): real probe when the engine is enabled — req('ping')
      // with the base 15s timeout; 'deferred' only when the engine is
      // explicitly disabled by config (engine.enabled: false).
      let ok = true;
      let engine: 'ready' | 'unavailable' | 'deferred' = 'deferred';
      if (ctx.sidecar) {
        ok = await ctx.sidecar
          .req('ping', {}, PING_TIMEOUT_MS)
          .then(
            () => true,
            () => false,
          );
        engine = ok ? 'ready' : 'unavailable';
      }
      return text({ ok, engine, version: VERSION });
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
