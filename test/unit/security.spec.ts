/**
 * Unit spec for the security layer (T4).
 *
 * Covers:
 * - C06/D4: crypto-secure token generation (32 bytes → 64 hex chars, unique),
 *   hash determinism, timing-safe verification (plaintext or pre-hashed
 *   config, never throws, no config = deny), and log redaction that never
 *   exposes the full token.
 * - C07/D5: policy matrix — read-only blocks mutating tools and allows reads;
 *   denyTools wins over allowTools; allow-only means default deny.
 * - C08/D6: denyBehavior 'error' announces (visible, clear reason) vs 'hide'
 *   (omitted from listings); reasons are stable, user-readable strings that
 *   never contain secret material.
 */
import { describe, expect, it } from 'vitest';

import { evaluateToolAccess, isToolListed, type ToolPolicy } from '../../src/security/policy.js';
import { generateToken, hashToken, redact, verifyToken } from '../../src/security/token.js';

describe('token generation (C06, D4)', () => {
  it('produces 64-character hex tokens (32 random bytes)', () => {
    const token = generateToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces unique tokens across many generations', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken()));
    expect(tokens.size).toBe(200);
  });
});

describe('token hashing', () => {
  it('is deterministic and yields a 64-char hex digest', () => {
    const token = generateToken();
    const first = hashToken(token);
    const second = hashToken(token);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('yields different digests for different tokens', () => {
    expect(hashToken(generateToken())).not.toBe(hashToken(generateToken()));
  });
});

describe('token verification (timing-safe)', () => {
  it('accepts the right token against a plaintext expectation', () => {
    const token = generateToken();
    expect(verifyToken(token, { token })).toBe(true);
  });

  it('rejects a wrong token against a plaintext expectation', () => {
    expect(verifyToken(generateToken(), { token: generateToken() })).toBe(false);
  });

  it('accepts the right token against a pre-hashed expectation', () => {
    const token = generateToken();
    expect(verifyToken(token, { tokenHash: hashToken(token) })).toBe(true);
  });

  it('rejects a wrong token against a pre-hashed expectation', () => {
    expect(verifyToken(generateToken(), { tokenHash: hashToken(generateToken()) })).toBe(false);
  });

  it('accepts uppercase hex hashes (case-insensitive digest form)', () => {
    const token = generateToken();
    expect(verifyToken(token, { tokenHash: hashToken(token).toUpperCase() })).toBe(true);
  });

  it('returns false (never throws) with no configured expectation', () => {
    const token = generateToken();
    expect(verifyToken(token, {})).toBe(false);
    expect(verifyToken(token, { token: undefined, tokenHash: undefined })).toBe(false);
  });

  it('returns false (never throws) on malformed hashes or length mismatches', () => {
    const token = generateToken();
    expect(verifyToken(token, { tokenHash: 'not-a-hash' })).toBe(false);
    expect(verifyToken(token, { tokenHash: 'a'.repeat(63) })).toBe(false);
    expect(verifyToken(token, { tokenHash: 'zz'.repeat(32) })).toBe(false);
    expect(verifyToken('', { tokenHash: 'ab' })).toBe(false);
    expect(verifyToken(token, { tokenHash: '' })).toBe(false);
  });

  it('verifies tokens of any length safely (digest comparison, no throw)', () => {
    expect(verifyToken('short-passphrase', { token: 'short-passphrase' })).toBe(true);
    expect(verifyToken('short-passphrase', { token: 'short-passphrasE' })).toBe(false);
  });
});

describe('token redaction', () => {
  it('never returns the full token, only a yatt_…abcd suffix', () => {
    const token = generateToken();
    const redacted = redact(token);

    expect(redacted).toBe(`yatt_…${token.slice(-4)}`);
    expect(redacted).not.toContain(token);
    expect(redacted.startsWith('yatt_…')).toBe(true);
    // Prefix + ellipsis + exactly 4 exposed characters.
    expect(redacted).toHaveLength(6 + 4);
  });

  it('masks short tokens entirely (no partial leak)', () => {
    expect(redact('')).toBe('yatt_…');
    expect(redact('abc')).toBe('yatt_…');
    expect(redact('abcdefg')).toBe('yatt_…');
  });
});

describe('tool policy matrix (C07, D5)', () => {
  const openPolicy: ToolPolicy = { readOnly: false, denyBehavior: 'error' };

  it('allows everything by default (reads and mutations)', () => {
    expect(evaluateToolAccess(openPolicy, 'test_create', { mutating: true })).toEqual({
      allowed: true,
    });
    expect(evaluateToolAccess(openPolicy, 'test_list', { mutating: false })).toEqual({
      allowed: true,
    });
  });

  it('read-only blocks mutating tools and still allows reads', () => {
    const policy: ToolPolicy = { readOnly: true, denyBehavior: 'error' };

    const denied = evaluateToolAccess(policy, 'test_create', { mutating: true });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe(
      "tool 'test_create' mutates state and this server runs in read-only mode",
    );

    expect(evaluateToolAccess(policy, 'test_list', { mutating: false })).toEqual({ allowed: true });
    expect(evaluateToolAccess(policy, 'test_get', { mutating: false })).toEqual({ allowed: true });
  });

  it('denyTools wins over allowTools', () => {
    const policy: ToolPolicy = {
      readOnly: false,
      allowTools: ['browser_open', 'browser_close'],
      denyTools: ['browser_open'],
      denyBehavior: 'error',
    };

    const denied = evaluateToolAccess(policy, 'browser_open', { mutating: true });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("tool 'browser_open' is not permitted by this server's policy");

    expect(evaluateToolAccess(policy, 'browser_close', { mutating: true })).toEqual({
      allowed: true,
    });
  });

  it('denyTools denies even non-mutating calls regardless of read-only mode', () => {
    const policy: ToolPolicy = {
      readOnly: true,
      denyTools: ['db_query'],
      denyBehavior: 'error',
    };

    const denied = evaluateToolAccess(policy, 'db_query', { mutating: false });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("tool 'db_query' is not permitted by this server's policy");
  });

  it('allowTools present means default deny for unlisted tools', () => {
    const policy: ToolPolicy = {
      readOnly: false,
      allowTools: ['test_list', 'test_get'],
      denyBehavior: 'error',
    };

    expect(evaluateToolAccess(policy, 'test_list', { mutating: false })).toEqual({ allowed: true });
    const denied = evaluateToolAccess(policy, 'browser_open', { mutating: true });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe("tool 'browser_open' is not permitted by this server's policy");
  });

  it("denyBehavior 'hide' marks denied tools hidden so callers omit them from listings", () => {
    const policy: ToolPolicy = {
      readOnly: false,
      denyTools: ['browser_open'],
      denyBehavior: 'hide',
    };

    const denied = evaluateToolAccess(policy, 'browser_open', { mutating: true });
    expect(denied).toEqual({
      allowed: false,
      reason: "tool 'browser_open' is not permitted by this server's policy",
      hidden: true,
    });
  });

  it("denyBehavior 'error' never sets hidden (D6: announce, stay visible)", () => {
    const policy: ToolPolicy = {
      readOnly: false,
      denyTools: ['browser_open'],
      denyBehavior: 'error',
    };

    const denied = evaluateToolAccess(policy, 'browser_open', { mutating: true });
    expect(denied.hidden).toBeUndefined();
    expect(denied.reason).toBeDefined();
  });

  it('isToolListed keeps denied tools visible under error and omits them under hide', () => {
    const denyError: ToolPolicy = { readOnly: false, denyTools: ['x'], denyBehavior: 'error' };
    const denyHide: ToolPolicy = { readOnly: false, denyTools: ['x'], denyBehavior: 'hide' };
    const allowHide: ToolPolicy = { readOnly: false, allowTools: ['a'], denyBehavior: 'hide' };

    expect(isToolListed(denyError, 'x')).toBe(true);
    expect(isToolListed(denyHide, 'x')).toBe(false);
    expect(isToolListed(denyHide, 'other')).toBe(true);

    // Allow-listed tool stays listed; unlisted tool is hidden under 'hide'.
    expect(isToolListed(allowHide, 'a')).toBe(true);
    expect(isToolListed(allowHide, 'b')).toBe(false);

    // Read-only mode never affects listings (mutating tools announce on call).
    const readOnly: ToolPolicy = { readOnly: true, denyBehavior: 'error' };
    expect(isToolListed(readOnly, 'test_create')).toBe(true);
  });
});

describe('denial reasons are user-readable and leak no secrets (D6)', () => {
  it('reason strings are stable and contain no token material', () => {
    const token = generateToken();
    const policies: ToolPolicy[] = [
      { readOnly: true, denyBehavior: 'error' },
      { readOnly: false, denyTools: ['test_delete'], denyBehavior: 'error' },
      { readOnly: false, allowTools: ['ping'], denyBehavior: 'hide' },
      { readOnly: false, denyTools: ['ping'], denyBehavior: 'hide' },
    ];

    for (const policy of policies) {
      for (const toolName of ['test_delete', 'ping']) {
        for (const mutating of [true, false]) {
          const result = evaluateToolAccess(policy, toolName, { mutating });
          if (result.allowed) {
            expect(result.reason).toBeUndefined();
            expect(result.hidden).toBeUndefined();
            continue;
          }
          expect(result.reason).toBeDefined();
          expect(result.reason).toMatch(/^tool '|^tool "/);
          expect(result.reason).toContain(toolName);
          expect(result.reason?.toLowerCase()).not.toContain(token.toLowerCase());
          // Reasons derive from fixed wording only: no hex-ish secret chunks.
          expect(result.reason).not.toMatch(/[0-9a-f]{16}/);
        }
      }
    }
  });
});
