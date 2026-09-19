/**
 * Token security primitives (D4, C06): crypto-secure generation, hashed
 * storage, timing-safe verification, and log-safe redaction.
 *
 * Security rules baked in:
 * - Tokens are 32 random bytes, hex-encoded (64 chars).
 * - Verification compares SHA-256 DIGESTS with `crypto.timingSafeEqual`, so
 *   the caller can hold either the plaintext token in memory or a pre-hashed
 *   value in config (`auth.token` / `auth.tokenHash`).
 * - Verification never throws: malformed or mismatched-length input is just a
 *   failed verification (`false`).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** SHA-256 digest length in bytes. */
const DIGEST_BYTES = 32;

/** A well-formed SHA-256 hex digest: exactly 64 hexadecimal characters. */
const HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Generates a new secure token: 32 crypto-random bytes as 64 hex characters.
 */
export function generateToken(): string {
  return randomBytes(DIGEST_BYTES).toString('hex');
}

/** SHA-256 hex digest (64 chars) of a token — the form stored in config (`auth.tokenHash`). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Verifies a presented token against the configured expectation, in constant
 * time over SHA-256 digests. Accepts either `expected.token` (plaintext in
 * memory) or `expected.tokenHash` (pre-hashed config); at most one is
 * honored, `token` taking precedence when both are somehow present. Returns
 * `false` — never throws — when no expectation is configured, the hash is
 * malformed, or the digests differ.
 */
export function verifyToken(
  presented: string,
  expected: { token?: string; tokenHash?: string },
): boolean {
  const presentedDigest = sha256Digest(presented);
  let expectedDigest: Buffer;

  if (typeof expected.token === 'string') {
    expectedDigest = sha256Digest(expected.token);
  } else if (typeof expected.tokenHash === 'string' && HASH_PATTERN.test(expected.tokenHash)) {
    expectedDigest = Buffer.from(expected.tokenHash.toLowerCase(), 'hex');
  } else {
    // No (usable) expectation configured: nothing can match.
    return false;
  }

  try {
    return timingSafeEqual(presentedDigest, expectedDigest);
  } catch {
    // Defensive: length mismatches throw inside timingSafeEqual; treat as failure.
    return false;
  }
}

/**
 * Redacts a token for logs: `yatt_…abcd` style. Only the last 4 characters
 * are ever shown, and tokens shorter than 8 characters are masked entirely,
 * so the full secret never appears in output.
 */
export function redact(token: string): string {
  if (token.length < 8) {
    return 'yatt_…';
  }
  return `yatt_…${token.slice(-4)}`;
}

function sha256Digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
