/**
 * Nano claims kept in a file, so a restart does not make old blocks
 * spendable again. Node only (it imports node:fs); the gateway itself never
 * imports this, so edge builds are unaffected.
 *
 * One line per claim, `<BLOCK HASH> <order id> <unix seconds>`, appended and
 * fsynced before the claim is reported as new, and read back on start. A torn
 * last line from a crash mid-write is skipped. One process per file: the
 * check-then-append is atomic inside this process, not across processes.
 */
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';

const LINE = /^([0-9A-F]{64}) ([A-Za-z0-9_-]{22,128}) (\d+)$/;

export function fileClaims(path) {
  if (!path) throw new Error('fileClaims needs a path');
  const byHash = new Map();
  const byOrder = new Map();
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  for (const line of text.split('\n')) {
    const m = LINE.exec(line.trim());
    if (!m || byHash.has(m[1]) || byOrder.has(m[2])) continue;
    byHash.set(m[1], { orderId: m[2], at: Number(m[3]) });
    byOrder.set(m[2], m[1]);
  }
  return {
    claim(hash, orderId, at) {
      const held = byHash.get(hash);
      if (held) return held.orderId === orderId ? { status: 'same', at: held.at } : { status: 'taken' };
      if (byOrder.has(orderId)) return { status: 'taken' };
      const line = `${hash} ${orderId} ${Math.floor(Number(at))}`;
      if (!LINE.test(line)) return { status: 'taken' };
      const fd = openSync(path, 'a', 0o600);
      try {
        // A newline first, so a torn line left by a crash cannot swallow this one.
        writeSync(fd, `\n${line}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      byHash.set(hash, { orderId, at: Math.floor(Number(at)) });
      byOrder.set(orderId, hash);
      return { status: 'new', at: Math.floor(Number(at)) };
    },
    /** How many claims are held, for health checks. */
    get size() {
      return byHash.size;
    },
  };
}
