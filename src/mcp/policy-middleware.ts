/**
 * Policy middleware (D5/D6, C07/C08): every tool handler is wrapped with an
 * access check before it reaches the MCP server.
 *
 * - Denied calls throw a `PolicyDeniedError` carrying the policy reason; the
 *   SDK turns it into a tool error result announcing WHY (D6: deny always
 *   announces, never silently fails).
 * - With `denyBehavior: 'hide'`, tools rejected by the lists are not
 *   registered at all (`isToolListed` filter at registration time).
 * - Read-only mode never hides tools: mutating ones stay visible and
 *   announce on call (C08).
 */
import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

import { evaluateToolAccess, isToolListed } from '../security/index.js';
import type { Ctx } from './ctx.js';

/** Extra argument the SDK passes to tool callbacks. */
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** A wrapped tool handler. Args are already parsed/validated by the SDK. */
export type ToolHandler = (args: Record<string, unknown>, extra: ToolExtra) => Promise<CallToolResult>;

/** Error thrown when the policy denies a tool call; message = policy reason. */
export class PolicyDeniedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PolicyDeniedError';
  }
}

/** Declarative definition of one MCP tool, policy metadata included. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** Raw zod shape (one schema per argument); the SDK validates + parses it. */
  inputSchema: z.ZodRawShape;
  /** Whether the call mutates state (drives read-only mode, C08). */
  mutating: boolean;
  handler: ToolHandler;
}

/** Registration sink that applies the policy middleware. */
export interface ToolRegistrar {
  register(def: ToolDefinition): void;
}

/**
 * Builds the registrar that wires tool definitions into the MCP server:
 * hidden tools are skipped, the rest are registered with the access check
 * in front of the handler.
 */
export function createToolRegistrar(server: McpServer, ctx: Ctx): ToolRegistrar {
  return {
    register(def: ToolDefinition): void {
      // denyBehavior 'hide' (C07): the tool never reaches the server, so it
      // is absent from listings and calls.
      if (!isToolListed(ctx.policy, def.name)) {
        return;
      }
      const wrapped = async (
        args: Record<string, unknown>,
        extra: ToolExtra,
      ): Promise<CallToolResult> => {
        const access = evaluateToolAccess(ctx.policy, def.name, { mutating: def.mutating });
        if (!access.allowed) {
          throw new PolicyDeniedError(access.reason ?? `tool '${def.name}' is not permitted`);
        }
        return def.handler(args, extra);
      };
      server.registerTool(
        def.name,
        { description: def.description, inputSchema: def.inputSchema },
        wrapped as unknown as ToolCallback<z.ZodRawShape>,
      );
    },
  };
}
