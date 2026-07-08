// src/components/CloudSync.tsx
//
// Drop-in Google Drive backup control for any MTAG settings panel. Renders a
// connect/disconnect button, the current panel's sync status, a "Sync now"
// action, and the Drive space used. Uses the shared useCloudSync hook so every
// panel behaves identically.
//
// Usage:
//   import { CloudSync } from './components/CloudSync';
//   <CloudSync panel="color" />

import { useCloudSync } from '../cloud/useCloudSync';
import type { PanelId } from '../cloud/config';

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
};

const fmtTime = (ms?: number): string => {
  if (!ms) return '';
  try { return new Date(ms).toLocaleString(); } catch { return ''; }
};

const wrap: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8,
  padding: '10px 12px', borderRadius: 8,
  background: 'var(--panel-bg-elev, rgba(127,127,127,0.08))',
  color: 'var(--panel-fg)', fontSize: 12,
};
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const btn: React.CSSProperties = {
  padding: '5px 10px', borderRadius: 6, border: '1px solid var(--panel-border, #3a3a3a)',
  background: 'transparent', color: 'var(--panel-fg)', cursor: 'pointer', fontSize: 12,
};
const btnPrimary: React.CSSProperties = {
  ...btn, background: 'var(--accent, #4c6ef5)', borderColor: 'transparent', color: '#fff',
};
const muted: React.CSSProperties = { color: 'var(--panel-fg-muted, #8a8f9c)', fontSize: 11 };

const stateDot = (state: string): React.CSSProperties => ({
  width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto',
  background:
    state === 'ok' ? '#3fb950'
    : state === 'syncing' ? '#d29922'
    : state === 'error' ? '#f85149'
    : state === 'conflict' ? '#db6d28'
    : '#6e7681',
});

export function CloudSync({ panel, title }: { panel: PanelId; title?: string }) {
  const cs = useCloudSync(panel);

  if (!cs.supported) {
    return (
      <div style={wrap}>
        <div style={{ fontWeight: 700 }}>{title ?? 'Cloud backup'}</div>
        <div style={muted}>
          Google Drive backup is unavailable — this build has no client ID configured,
          or the panel isn’t running in After Effects / Illustrator.
        </div>
      </div>
    );
  }

  const signedIn = cs.auth.status === 'signed-in';
  const busy = cs.auth.status === 'signing-in' || cs.status?.state === 'syncing';

  return (
    <div style={wrap}>
      <div style={row}>
        <div style={{ fontWeight: 700, flex: 1 }}>{title ?? 'Google Drive backup'}</div>
        {signedIn && <span style={stateDot(cs.status?.state ?? 'idle')} />}
      </div>

      {!signedIn && (
        <>
          <div style={muted}>
            Save this panel’s presets and settings to a private folder in your own
            Google Drive, and restore them on any machine.
          </div>
          <div style={row}>
            <button
              style={btnPrimary}
              disabled={cs.auth.status === 'signing-in'}
              onClick={() => cs.signIn()}
            >
              {cs.auth.status === 'signing-in' ? 'Connecting…' : 'Connect Google Drive'}
            </button>
          </div>
          {cs.auth.status === 'error' && (
            <div style={{ ...muted, color: '#f85149' }}>{cs.auth.message}</div>
          )}
        </>
      )}

      {signedIn && (
        <>
          <div style={{ ...row, ...muted }}>
            <span>
              {cs.status?.state === 'syncing' ? 'Syncing…'
                : cs.status?.state === 'error' ? `Error: ${cs.status.message}`
                : cs.status?.lastSyncedAt ? `Last synced ${fmtTime(cs.status.lastSyncedAt)}`
                : cs.status?.message ?? 'Connected'}
            </span>
          </div>

          <div style={row}>
            <button style={btn} disabled={busy} onClick={() => cs.sync()}>
              {busy ? 'Working…' : 'Sync now'}
            </button>
            <button style={btn} disabled={busy} onClick={() => cs.push()}>
              Back up now
            </button>
            <div style={{ flex: 1 }} />
            <button style={btn} onClick={() => cs.signOut()}>Disconnect</button>
          </div>

          <div style={muted}>
            {cs.usage
              ? `Using ${fmtBytes(cs.usage.bytes)} across ${cs.usage.count} file${cs.usage.count === 1 ? '' : 's'} in your Drive app folder.`
              : 'Calculating space used…'}
          </div>
        </>
      )}
    </div>
  );
}
