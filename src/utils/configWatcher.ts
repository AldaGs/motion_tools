// src/utils/configWatcher.ts
//
// Single shared watcher for the macros + easing config files. Replaces the
// per-component setInterval(stat, 500ms) pollers — both panels (App and
// EasingEditor) used to run their own copy.
//
// Strategy:
//   - Prefer fs.watch (event-driven, ~0 cost when idle).
//   - Fall back to a single polling interval if fs.watch isn't available
//     (e.g. unusual filesystems, CEF on certain Windows network shares).
//   - In either case, debounce notifications by 80ms — atomic-rename writes
//     fire two events (rename of .tmp + rename to final) and we want one.
//
// Subscribers are reference-counted; the underlying watcher tears down when
// the last one unsubscribes.

import { getConfigPath, getEasingPath } from './storage';

type Listener = () => void;

let listeners = new Set<Listener>();
let watchers: any[] = [];
let pollInterval: number | null = null;
let debounceTimer: number | null = null;
let lastMtimes: Record<string, number> = {};

const notifyDebounced = () => {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    for (const fn of listeners) {
      try { fn(); } catch (e) { console.error('configWatcher listener threw', e); }
    }
  }, 80);
};

const start = () => {
  if (typeof window.require !== 'function') return;
  let fs: any;
  try { fs = window.require('fs'); } catch { return; }

  const paths = [getConfigPath(), getEasingPath()].filter(Boolean) as string[];
  if (paths.length === 0) return;

  // Seed mtimes so initial subscribe doesn't fire immediately.
  for (const p of paths) {
    try { lastMtimes[p] = fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0; }
    catch { lastMtimes[p] = 0; }
  }

  // Try event-driven watch on each file's containing directory — watching
  // the file directly breaks across atomic-rename writes (the watched inode
  // disappears). Watching the dir survives the rename.
  let useFsWatch = true;
  try {
    const path = window.require('path');
    const dirs = Array.from(new Set(paths.map((p) => path.dirname(p))));
    for (const dir of dirs) {
      const w = fs.watch(dir, { persistent: false }, (_evt: string, _name: string) => {
        // We don't trust the filename arg (Windows often gives stale/null),
        // so just re-stat on any event in this dir.
        let changed = false;
        for (const p of paths) {
          try {
            const m = fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0;
            if (m !== lastMtimes[p]) { lastMtimes[p] = m; changed = true; }
          } catch { /* ignore */ }
        }
        if (changed) notifyDebounced();
      });
      watchers.push(w);
    }
  } catch (e) {
    useFsWatch = false;
  }

  // Polling fallback. Also kept as a safety net at 1 Hz even when fs.watch
  // succeeded, in case the CEF host drops events on us.
  const intervalMs = useFsWatch ? 2000 : 500;
  pollInterval = window.setInterval(() => {
    let changed = false;
    for (const p of paths) {
      try {
        const m = fs.existsSync(p) ? fs.statSync(p).mtimeMs : 0;
        if (m !== lastMtimes[p]) { lastMtimes[p] = m; changed = true; }
      } catch { /* ignore */ }
    }
    if (changed) notifyDebounced();
  }, intervalMs);
};

const stop = () => {
  for (const w of watchers) {
    try { w.close(); } catch { /* ignore */ }
  }
  watchers = [];
  if (pollInterval !== null) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  lastMtimes = {};
};

/** Subscribe to config-file changes. Returns an unsubscribe function. */
export function subscribeConfigChanges(fn: Listener): () => void {
  const wasEmpty = listeners.size === 0;
  listeners.add(fn);
  if (wasEmpty) start();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) stop();
  };
}
