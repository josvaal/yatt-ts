/**
 * Prompts: work templates the client can load. Ported from the base
 * `mcp/src/prompts.ts`; names, descriptions and bodies come from the i18n
 * module (D14): Spanish names under `es` (crear-test, …), English under
 * `en` (create-test, …).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { YattStrings } from '../i18n/index.js';

export function registerPrompts(server: McpServer, strings: YattStrings): void {
  for (const prompt of strings.prompts) {
    server.registerPrompt(
      prompt.name,
      { description: prompt.description },
      async () => ({
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: prompt.text,
            },
          },
        ],
      }),
    );
  }
}
