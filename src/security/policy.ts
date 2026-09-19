/**
 * Tool access policy (D5, D6, C07/C08): global read-only mode plus per-tool
 * allow/deny lists, with two denial behaviors — announce (default, the tool
 * stays visible and fails with a clear permission error) or hide (the tool is
 * omitted from listings entirely).
 *
 * Precedence rules:
 * 1. `denyTools` wins over everything, including `allowTools`.
 * 2. When `allowTools` is set, anything not listed is denied (default deny).
 * 3. Read-only mode denies mutating tools; read tools keep working.
 *
 * Denial reasons are stable, user-readable strings that never contain secret
 * material (they are built only from the tool name and fixed wording).
 */

/** Declarative permission policy for the MCP tool surface. */
export interface ToolPolicy {
  /** When true, every state-mutating tool is denied. */
  readOnly: boolean;
  /** When present, ONLY these tools are allowed (default deny for the rest). */
  allowTools?: string[];
  /** Tools rejected regardless of `allowTools` and of read-only mode. */
  denyTools?: string[];
  /** 'error' announces the denial on call (D6); 'hide' also omits the tool from listings. */
  denyBehavior: 'error' | 'hide';
}

/** Outcome of evaluating a tool call against a policy. */
export interface ToolAccess {
  allowed: boolean;
  /** Present only when denied: clear, user-readable reason (D6). */
  reason?: string;
  /** Present (true) only when denied AND `denyBehavior: 'hide'`: callers omit the tool from listings. */
  hidden?: boolean;
}

/** Options for a single tool-call evaluation. */
export interface ToolCallOptions {
  /** Whether the call mutates state (writes, runs, deletes). */
  mutating: boolean;
}

/**
 * Evaluates whether a tool call is permitted. Denied results always carry a
 * clear reason; `hidden: true` is added only when the policy's denyBehavior
 * is 'hide' so callers can omit the tool from listings.
 */
export function evaluateToolAccess(
  policy: ToolPolicy,
  toolName: string,
  opts: ToolCallOptions,
): ToolAccess {
  const reason = denialReason(policy, toolName, opts.mutating);
  if (reason === null) {
    return { allowed: true };
  }
  if (policy.denyBehavior === 'hide') {
    return { allowed: false, reason, hidden: true };
  }
  return { allowed: false, reason };
}

/**
 * Whether a tool should appear in tool listings: denied tools stay visible
 * under 'error' (D6: announce, never silently hide) and are omitted under
 * 'hide'. Read-only mode never affects listings — mutating tools remain
 * visible and announce on call.
 */
export function isToolListed(policy: ToolPolicy, toolName: string): boolean {
  const deniedByLists =
    (policy.denyTools?.includes(toolName) ?? false) ||
    (policy.allowTools !== undefined && !policy.allowTools.includes(toolName));
  return !(deniedByLists && policy.denyBehavior === 'hide');
}

/** Returns the denial reason, or null when the call is allowed. */
function denialReason(policy: ToolPolicy, toolName: string, mutating: boolean): string | null {
  // 1. Explicit deny list wins over everything.
  if (policy.denyTools?.includes(toolName)) {
    return notPermitted(toolName);
  }
  // 2. Allow list present: default deny for anything not listed.
  if (policy.allowTools !== undefined && !policy.allowTools.includes(toolName)) {
    return notPermitted(toolName);
  }
  // 3. Global read-only mode blocks mutating tools.
  if (policy.readOnly && mutating) {
    return `tool '${toolName}' mutates state and this server runs in read-only mode`;
  }
  return null;
}

function notPermitted(toolName: string): string {
  return `tool '${toolName}' is not permitted by this server's policy`;
}
