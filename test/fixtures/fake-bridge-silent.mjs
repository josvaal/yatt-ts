/**
 * Silent bridge: never emits sidecar_ready, never answers. Exercises the
 * ready fail-timer of the engine client.
 */
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('close', () => process.exit(0));
