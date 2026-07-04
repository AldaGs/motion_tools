// Small ring-buffer log the MTAG Switch diagnostic panel reads from.
// Kept intentionally standalone so transport code never imports React.

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
}

const MAX = 200;
const buf: LogEntry[] = [];
const listeners = new Set<(entries: LogEntry[]) => void>();

export function log(level: LogLevel, msg: string) {
  buf.push({ ts: Date.now(), level, msg });
  if (buf.length > MAX) buf.shift();
  const snapshot = buf.slice();
  listeners.forEach((fn) => fn(snapshot));
}

export const info = (m: string) => log('info', m);
export const warn = (m: string) => log('warn', m);
export const err = (m: string) => log('error', m);

export function subscribeLog(fn: (entries: LogEntry[]) => void): () => void {
  listeners.add(fn);
  fn(buf.slice());
  return () => { listeners.delete(fn); };
}
