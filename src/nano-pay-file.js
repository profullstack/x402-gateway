/**
 * The buyer's pending Nano payments kept in a file, so a restart between
 * "the block is out" and "the proof was accepted" re-presents that block
 * instead of paying again. Node only (it imports node:fs); `nano-pay.js`
 * never imports this, so edge builds are unaffected.
 *
 * One JSON line per change, appended and fsynced before `put` or `delete`
 * returns, and replayed on start (last line for a key wins). A torn last line
 * from a crash mid-write is skipped. One process per file.
 */
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';

export function filePending(path) {
  if (!path) throw new Error('filePending needs a path');
  const held = new Map();
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  for (const line of text.split('\n')) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry.key !== 'string') continue;
    if (entry.value && typeof entry.value === 'object') held.set(entry.key, entry.value);
    else held.delete(entry.key);
  }
  const append = (entry) => {
    const fd = openSync(path, 'a', 0o600);
    try {
      // A newline first, so a torn line left by a crash cannot swallow this one.
      writeSync(fd, `\n${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  return {
    get: (key) => (held.has(key) ? { ...held.get(key) } : null),
    put(key, value) {
      append({ key, value });
      held.set(key, { ...value });
    },
    delete(key) {
      if (!held.has(key)) return;
      append({ key, value: null });
      held.delete(key);
    },
    /** How many payments are pending, for health checks. */
    get size() {
      return held.size;
    },
  };
}
