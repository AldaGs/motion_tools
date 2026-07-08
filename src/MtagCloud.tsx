// src/MtagCloud.tsx
//
// The shared "MTAG Cloud" panel: one place to connect Google Drive, see every
// panel's sync status, back up / restore, and check space used. All five panels
// persist into the same AGS-Extensions config dir, so this dashboard drives the
// whole suite from a single sign-in.

import { useCallback, useEffect, useState } from 'react';
import {
  isSupported,
  hasStoredSession,
  signIn as authSignIn,
  signOut as authSignOut,
} from './cloud/googleAuth';
import { syncPanel, pushPanel, pullPanel, syncAll } from './cloud/syncEngine';
import { appDataUsage } from './cloud/driveClient';
import { PANELS } from './cloud/config';
import type { PanelId } from './cloud/config';
import type { AuthState, PanelSyncStatus } from './cloud/types';

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
};

const fmtTime = (ms?: number): string => {
  if (!ms) return '—';
  try { return new Date(ms).toLocaleString(); } catch { return '—'; }
};

const PANEL_ORDER: PanelId[] = ['color', 'gifs', 'eases', 'toolbar', 'switch'];

const stateColor = (state?: string): string =>
  state === 'ok' ? '#3fb950'
  : state === 'syncing' ? '#d29922'
  : state === 'error' ? '#f85149'
  : state === 'conflict' ? '#db6d28'
  : '#6e7681';

export default function MtagCloud() {
  const supported = isSupported();
  const [auth, setAuth] = useState<AuthState>(() =>
    supported && hasStoredSession() ? { status: 'signed-in' } : { status: 'signed-out' },
  );
  const [statuses, setStatuses] = useState<Record<PanelId, PanelSyncStatus | undefined>>(
    {} as Record<PanelId, PanelSyncStatus | undefined>,
  );
  const [usage, setUsage] = useState<{ bytes: number; count: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const signedIn = auth.status === 'signed-in';

  const refreshUsage = useCallback(async () => {
    if (!hasStoredSession()) return;
    try { setUsage(await appDataUsage()); } catch { /* non-fatal */ }
  }, []);

  const setOne = (s: PanelSyncStatus) =>
    setStatuses((prev) => ({ ...prev, [s.panel]: s }));

  const syncEverything = useCallback(async () => {
    if (!hasStoredSession()) return;
    setBusy(true);
    for (const id of PANEL_ORDER) setOne({ panel: id, state: 'syncing' });
    const res = await syncAll();
    for (const r of res) setOne(r);
    await refreshUsage();
    setBusy(false);
  }, [refreshUsage]);

  const doSignIn = async () => {
    setAuth({ status: 'signing-in' });
    try {
      const stored = await authSignIn();
      setAuth({ status: 'signed-in', account: stored.account });
      await syncEverything();
    } catch (e: any) {
      setAuth({ status: 'error', message: e?.message ?? String(e) });
    }
  };

  const doSignOut = async () => {
    await authSignOut();
    setAuth({ status: 'signed-out' });
    setStatuses({} as Record<PanelId, PanelSyncStatus | undefined>);
    setUsage(null);
  };

  const onePanel = async (id: PanelId, op: 'sync' | 'push' | 'pull') => {
    setOne({ panel: id, state: 'syncing' });
    const fn = op === 'push' ? pushPanel : op === 'pull' ? pullPanel : syncPanel;
    setOne(await fn(id));
    await refreshUsage();
  };

  // Reconcile everything once on open if already connected.
  useEffect(() => {
    if (supported && hasStoredSession()) {
      const t = setTimeout(() => { syncEverything(); }, 0);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const wrap: React.CSSProperties = {
    height: '100vh', overflowY: 'auto', color: 'var(--panel-fg)',
    fontSize: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12,
  };
  const btn: React.CSSProperties = {
    padding: '5px 10px', borderRadius: 6, border: '1px solid var(--panel-border)',
    background: 'var(--panel-bg-elev)', color: 'var(--panel-fg)', cursor: 'pointer', fontSize: 11,
  };
  const btnPrimary: React.CSSProperties = {
    ...btn, background: '#4c6ef5', borderColor: 'transparent', color: '#fff', padding: '7px 14px', fontSize: 12,
  };
  const muted: React.CSSProperties = { color: 'var(--panel-fg-muted)', fontSize: 11 };

  if (!supported) {
    return (
      <div style={wrap}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>MTAG Cloud</div>
        <div style={muted}>
          Google Drive backup is unavailable — this build has no client ID configured
          (set <code>GOOGLE_CLIENT_ID</code> in <code>src/cloud/config.ts</code>), or the
          panel isn’t running inside After Effects / Illustrator.
        </div>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>MTAG Cloud</div>
        {signedIn && (
          <button style={btn} onClick={doSignOut}>Disconnect</button>
        )}
      </div>

      {!signedIn && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '8px 0' }}>
          <div style={muted}>
            Connect your Google account to back up presets and settings for all MTAG panels
            to a private folder in your own Google Drive — and restore them on any machine.
            We only ever access our own app folder; never your other files.
          </div>
          <div>
            <button style={btnPrimary} disabled={auth.status === 'signing-in'} onClick={doSignIn}>
              {auth.status === 'signing-in' ? 'Connecting…' : 'Connect Google Drive'}
            </button>
          </div>
          {auth.status === 'error' && (
            <div style={{ ...muted, color: '#f85149' }}>{auth.message}</div>
          )}
          <div style={{ ...muted, marginTop: 4 }}>
            A browser window will open for Google sign-in. After approving, return to Adobe —
            this panel picks up the connection automatically.
          </div>
        </div>
      )}

      {signedIn && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button style={btnPrimary} disabled={busy} onClick={syncEverything}>
              {busy ? 'Syncing…' : 'Sync all'}
            </button>
            <div style={{ flex: 1 }} />
            <span style={muted}>
              {usage
                ? `${fmtBytes(usage.bytes)} · ${usage.count} file${usage.count === 1 ? '' : 's'}`
                : 'Calculating…'}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {PANEL_ORDER.map((id) => {
              const st = statuses[id];
              return (
                <div
                  key={id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 10px', borderRadius: 8,
                    background: 'var(--panel-bg-elev)', border: '1px solid var(--panel-border)',
                  }}
                >
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto',
                    background: stateColor(st?.state),
                  }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{PANELS[id].label}</div>
                    <div style={{ ...muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {st?.state === 'syncing' ? 'Syncing…'
                        : st?.state === 'error' ? `Error: ${st.message}`
                        : st?.lastSyncedAt ? `Synced ${fmtTime(st.lastSyncedAt)}`
                        : st?.message ?? 'Not synced yet'}
                    </div>
                  </div>
                  <button style={btn} disabled={busy} title="Back up this panel to Drive"
                    onClick={() => onePanel(id, 'push')}>Back up</button>
                  <button style={btn} disabled={busy} title="Restore this panel from Drive"
                    onClick={() => onePanel(id, 'pull')}>Restore</button>
                </div>
              );
            })}
          </div>

          <div style={{ ...muted, marginTop: 4 }}>
            “Back up” pushes this machine’s settings to Drive; “Restore” pulls the Drive copy
            down. “Sync all” reconciles every panel, keeping whichever side changed most recently.
          </div>
        </>
      )}
    </div>
  );
}
