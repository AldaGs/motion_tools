// src/components/Toaster.tsx
import { useEffect, useState } from 'react';
import { subscribeToasts, type Toast } from '../utils/toast';

const KIND_STYLE: Record<Toast['kind'], { bg: string; bd: string }> = {
  success: { bg: 'rgba(46, 204, 113, 0.12)', bd: 'var(--success)' },
  error:   { bg: 'rgba(231, 76, 60, 0.14)',  bd: 'var(--danger)'  },
  info:    { bg: 'rgba(52, 152, 219, 0.12)', bd: 'var(--accent)'  },
};

const VISIBLE_MS = 2800;
const EXIT_MS = 220;

interface ActiveToast extends Toast { exiting?: boolean }

export default function Toaster() {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);

  useEffect(() => subscribeToasts((t) => {
    setToasts((cur) => [...cur, t]);
    setTimeout(() => {
      setToasts((cur) => cur.map((x) => (x.id === t.id ? { ...x, exiting: true } : x)));
    }, VISIBLE_MS);
    setTimeout(() => {
      setToasts((cur) => cur.filter((x) => x.id !== t.id));
    }, VISIBLE_MS + EXIT_MS);
  }), []);

  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, bottom: 12, zIndex: 200,
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
      pointerEvents: 'none', padding: '0 12px',
    }}>
      {toasts.map((t) => {
        const s = KIND_STYLE[t.kind];
        return (
          <div key={t.id} style={{
            backgroundColor: s.bg, border: `1px solid ${s.bd}`, color: 'var(--panel-fg)',
            padding: '6px 12px', borderRadius: 'var(--radius-md)', fontSize: '12px',
            maxWidth: '100%', boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
            backdropFilter: 'blur(4px)',
            animation: t.exiting
              ? `mt-toast-out ${EXIT_MS}ms ease-in forwards`
              : `mt-toast-in 200ms cubic-bezier(0.2, 0.8, 0.2, 1)`,
            pointerEvents: 'auto',
          }}>
            {t.msg}
          </div>
        );
      })}
    </div>
  );
}
