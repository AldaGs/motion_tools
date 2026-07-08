// src/cloud/useCloudSync.ts
//
// Shared React hook every MTAG panel uses to drive Google Drive backup. Owns
// auth state, per-panel sync status, and the space-usage figure. It does NOT
// auto-push on every save — panels call `push()` (debounced by the caller) so
// the hook stays free of panel-specific save plumbing.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isSupported,
  hasStoredSession,
  signIn as authSignIn,
  signOut as authSignOut,
} from './googleAuth';
import { syncPanel, pushPanel, syncAll } from './syncEngine';
import { appDataUsage } from './driveClient';
import type { PanelId } from './config';
import type { AuthState, PanelSyncStatus } from './types';

export interface UseCloudSync {
  supported: boolean;
  auth: AuthState;
  status: PanelSyncStatus | null;
  usage: { bytes: number; count: number } | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Two-way reconcile this panel now. */
  sync: () => Promise<void>;
  /** Push local -> remote for this panel (call after a save). */
  push: () => Promise<void>;
  /** Reconcile every panel (used from a global Settings screen). */
  syncEverything: () => Promise<PanelSyncStatus[]>;
  /** Refresh the Drive space-usage figure. */
  refreshUsage: () => Promise<void>;
}

/**
 * @param panel      which panel this hook instance syncs
 * @param autoSyncOnMount  reconcile once on mount if already signed in
 */
export const useCloudSync = (panel: PanelId, autoSyncOnMount = true): UseCloudSync => {
  const supported = isSupported();
  const [auth, setAuth] = useState<AuthState>(() =>
    supported && hasStoredSession() ? { status: 'signed-in' } : { status: 'signed-out' },
  );
  const [status, setStatus] = useState<PanelSyncStatus | null>(null);
  const [usage, setUsage] = useState<{ bytes: number; count: number } | null>(null);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  const refreshUsage = useCallback(async () => {
    if (!supported || !hasStoredSession()) return;
    try {
      const u = await appDataUsage();
      if (mounted.current) setUsage(u);
    } catch { /* non-fatal */ }
  }, [supported]);

  const sync = useCallback(async () => {
    if (!supported || !hasStoredSession()) return;
    setStatus({ panel, state: 'syncing' });
    const res = await syncPanel(panel);
    if (mounted.current) setStatus(res);
    refreshUsage();
  }, [panel, supported, refreshUsage]);

  const push = useCallback(async () => {
    if (!supported || !hasStoredSession()) return;
    setStatus({ panel, state: 'syncing' });
    const res = await pushPanel(panel);
    if (mounted.current) setStatus(res);
    refreshUsage();
  }, [panel, supported, refreshUsage]);

  const signIn = useCallback(async () => {
    if (!supported) return;
    setAuth({ status: 'signing-in' });
    try {
      const stored = await authSignIn();
      if (!mounted.current) return;
      setAuth({ status: 'signed-in', account: stored.account });
      // First reconcile right after connecting.
      await sync();
    } catch (e: any) {
      if (mounted.current) setAuth({ status: 'error', message: e?.message ?? String(e) });
    }
  }, [supported, sync]);

  const signOut = useCallback(async () => {
    await authSignOut();
    if (!mounted.current) return;
    setAuth({ status: 'signed-out' });
    setStatus(null);
    setUsage(null);
  }, []);

  const syncEverything = useCallback(async () => {
    if (!supported || !hasStoredSession()) return [];
    const res = await syncAll();
    if (mounted.current) {
      const mine = res.find((r) => r.panel === panel);
      if (mine) setStatus(mine);
    }
    refreshUsage();
    return res;
  }, [supported, panel, refreshUsage]);

  // Auto-reconcile once on mount if we already have a session. Deferred to a
  // microtask so we don't setState synchronously inside the effect body (which
  // would trigger a cascading render) — the actual work is async anyway.
  useEffect(() => {
    if (autoSyncOnMount && supported && hasStoredSession()) {
      const t = setTimeout(() => { if (mounted.current) sync(); }, 0);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    supported, auth, status, usage,
    signIn, signOut, sync, push, syncEverything, refreshUsage,
  };
};
