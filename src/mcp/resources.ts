/**
 * MCP resources: content the client can read as context. Ported from the
 * base `mcp/src/resources.ts`, with locale-aware copy (D14).
 */
import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { YattStrings } from '../i18n/index.js';
import type { Ctx } from './ctx.js';

export function registerResources(server: McpServer, ctx: Ctx, strings: YattStrings): void {
  const { store } = ctx;
  const msg = strings.messages;

  server.resource(
    'schema',
    'yatt://schema',
    { description: strings.resources.schema, mimeType: 'text/markdown' },
    async (uri) => ({
      contents: [{ uri: uri.href, text: strings.schemaDoc, mimeType: 'text/markdown' }],
    }),
  );

  server.resource(
    'test',
    new ResourceTemplate('yatt://tests/{name}', { list: undefined }),
    { description: strings.resources.test, mimeType: 'application/json' },
    async (uri, variables) => {
      const name = String(variables.name);
      const content = store.testGet(name);
      if (content === null) throw new Error(msg.testDoesNotExist(name));
      return { contents: [{ uri: uri.href, text: content, mimeType: 'application/json' }] };
    },
  );

  server.resource(
    'report',
    new ResourceTemplate('yatt://reports/{name}', { list: undefined }),
    { description: strings.resources.report, mimeType: 'application/json' },
    async (uri, variables) => {
      const name = String(variables.name);
      const content = store.reportGet(name);
      // F9: this is the READ resource — the miss message must point at
      // report_list (reportMissingDelete was the wrong copy).
      if (content === null) throw new Error(msg.reportMissingGet(name));
      return { contents: [{ uri: uri.href, text: content, mimeType: 'application/json' }] };
    },
  );
}
