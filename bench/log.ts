// Run log: everything printed to the console, timestamped, plus full error details, appended to
// results/<run>.log as it happens, so a run that dies hours in still leaves its trail on disk.
import { appendFileSync } from 'node:fs';

let file: string | undefined;
let closed = false;
const seen = new Map<string, number>();

export function openLog(path: string) {
  file = path;
}

/** After the final RUN FINISHED line nothing else is written (late failures of in-flight queries). */
export function closeLog() {
  closed = true;
}

export function log(msg: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO') {
  if (closed) return;
  (level === 'INFO' ? console.log : console.error)(level === 'INFO' ? msg : `${level} ${msg}`);
  if (file) appendFileSync(file, `${new Date().toISOString()} ${level.padEnd(5)} ${msg.replace(/\n/g, '\n    ')}\n`);
}

/** File only: per-window heartbeat and step markers, too chatty for the console. */
export function trace(msg: string) {
  if (file && !closed) appendFileSync(file, `${new Date().toISOString()} TRACE ${msg}\n`);
}

/** Logs the first occurrence of `key` in full, then every 1000th as a count, so repeated errors can't flood the log. */
export function logOnce(key: string, detail: () => string, level: 'WARN' | 'ERROR' = 'ERROR') {
  const n = (seen.get(key) ?? 0) + 1;
  seen.set(key, n);
  if (n === 1) log(`${key}\n${detail()}`, level);
  else if (n % 1000 === 0) log(`${key} (seen ${n} times)`, level);
}

/** Everything useful in an error from the driver or Node: class, codes, message, stack, cause. */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const x = e as Error & { code?: unknown; gqlStatus?: unknown; classification?: unknown; retriable?: unknown };
  const meta = { code: x.code, gqlStatus: x.gqlStatus, classification: x.classification, retriable: x.retriable };
  const fields = Object.entries(meta)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const cause = x.cause ? `\ncaused by: ${describeError(x.cause)}` : '';
  const frames = (x.stack ?? '')
    .split('\n')
    .filter((l) => l.trimStart().startsWith('at '))
    .slice(0, 8);
  return `${x.name}${fields ? ` [${fields}]` : ''}: ${x.message}\n${frames.join('\n')}${cause}`;
}

export const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0];
