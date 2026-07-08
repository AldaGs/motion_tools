// src/components/OpenCloudButton.tsx
//
// Small "☁ MTAG Cloud" launcher for any settings panel. Opens the shared cloud
// dashboard and shows a dot reflecting connection state. Deliberately tiny — it
// doesn't run the sync itself, just routes the user to the dashboard.

import { openCloudPanel } from '../cloud/openCloudPanel';
import { isSupported, hasStoredSession } from '../cloud/googleAuth';

export function OpenCloudButton({ style }: { style?: React.CSSProperties }) {
  if (!isSupported()) return null;
  const connected = hasStoredSession();

  return (
    <button
      onClick={openCloudPanel}
      title={connected ? 'Google Drive connected — open MTAG Cloud' : 'Back up to Google Drive — open MTAG Cloud'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '5px 10px', borderRadius: 6,
        border: '1px solid var(--panel-border)', background: 'var(--panel-bg-elev)',
        color: 'var(--panel-fg)', cursor: 'pointer', fontSize: 11, ...style,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto',
          background: connected ? '#3fb950' : '#6e7681',
        }}
      />
      ☁ MTAG Cloud
    </button>
  );
}
