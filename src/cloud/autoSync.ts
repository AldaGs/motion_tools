// src/cloud/autoSync.ts
//
// Debounced background backup. Panels call scheduleAutoPush(panel) after a
// local save; we coalesce rapid saves and push once things settle, but only
// when a Drive session actually exists. Fully fire-and-forget: a failed push
// never throws into the caller's save path.

import { isSupported, hasStoredSession } from './googleAuth';
import { pushPanel } from './syncEngine';
import type { PanelId } from './config';

const DEBOUNCE_MS = 3000;

const timers = new Map<PanelId, ReturnType<typeof setTimeout>>();

/** Queue a background backup of `panel`. No-ops when the feature is
 * unavailable or the user isn't signed in, so it's safe to call from every
 * save regardless of cloud state. */
export const scheduleAutoPush = (panel: PanelId): void => {
  if (!isSupported() || !hasStoredSession()) return;

  const existing = timers.get(panel);
  if (existing) clearTimeout(existing);

  const t = setTimeout(() => {
    timers.delete(panel);
    // Re-check: the user may have signed out during the debounce window.
    if (!hasStoredSession()) return;
    pushPanel(panel).catch((e) => {
      console.warn(`Auto-backup for ${panel} failed (will retry on next save)`, e);
    });
  }, DEBOUNCE_MS);

  timers.set(panel, t);
};

/** Flush any pending auto-pushes immediately (e.g. on panel unload). Returns a
 * promise that resolves once all in-flight pushes settle. Best-effort. */
export const flushAutoPush = async (): Promise<void> => {
  if (!hasStoredSession()) { timers.clear(); return; }
  const pending: PanelId[] = [];
  for (const [panel, t] of timers) {
    clearTimeout(t);
    pending.push(panel);
  }
  timers.clear();
  await Promise.allSettled(pending.map((p) => pushPanel(p)));
};
