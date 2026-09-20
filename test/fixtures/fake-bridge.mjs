/**
 * Fake engine bridge for unit tests: speaks the newline-delimited JSON-RPC
 * protocol of the yatt engine without any browser.
 *
 * Methods:
 *   ping                → { ok: true, pid }
 *   echo                → echoes params as the result
 *   delay               → responds after params.ms with { echoed, receiptIndex, receiptMs }
 *   fail_with_data      → ok:false with a result payload (error .data passthrough)
 *   slow_never          → never responds (request-timeout test)
 */
import { createInterface } from 'node:readline';

const t0 = Date.now();
let receipts = 0;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id, ok, result) {
  send({ type: 'response', id, ok, result });
}

send({ type: 'event', name: 'sidecar_ready', data: { pid: process.pid } });

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const id = req.id;
  const method = req.method;
  const params = req.params ?? {};
  if (method === 'ping') {
    respond(id, true, { ok: true, pid: process.pid });
    return;
  }
  if (method === 'echo') {
    respond(id, true, params);
    return;
  }
  if (method === 'delay') {
    const ms = Number(params.ms) || 0;
    const receiptIndex = ++receipts;
    const receiptMs = Date.now() - t0;
    setTimeout(() => {
      respond(id, true, { echoed: params.echo ?? null, receiptIndex, receiptMs });
    }, ms);
    return;
  }
  if (method === 'fail_with_data') {
    send({
      type: 'response',
      id,
      ok: false,
      error: 'engine failure',
      result: { screenshot: 'base64-evidence', step: params },
    });
    return;
  }
  if (method === 'slow_never') {
    return; // intentionally unanswered: exercises the request timeout
  }
  respond(id, false, { error: 'unknown method: ' + method });
});

// Orderly close: EOF on stdin → exit 0 (like the real bridge).
rl.on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
