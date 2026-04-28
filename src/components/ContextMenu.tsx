// src/components/ContextMenu.tsx
//
// Lightweight right-click menu. Mirrors the move-menu popover pattern in
// App.tsx (outside-click + Escape close, ref-based hit-test) so the two
// menus feel identical.

import { useEffect, useRef } from 'react';

export interface ContextMenuItem {
  /** Stable key — also used as a React key. */
  id: string;
  label: string;
  onSelect: () => void;
  /** When true, the item is rendered dimmed and ignores clicks. */
  disabled?: boolean;
  /** Renders a thin separator above this item. */
  divider?: boolean;
  /** Optional small icon char (emoji / unicode). */
  icon?: string;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

const MENU_W = 200;
const ITEM_H = 28;

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && ref.current.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Closing on a *new* contextmenu event lets the user move directly to
    // a different right-click target without an extra click.
    const onCtxElsewhere = (e: MouseEvent) => {
      if (ref.current && ref.current.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('contextmenu', onCtxElsewhere);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('contextmenu', onCtxElsewhere);
    };
  }, [onClose]);

  // Clamp inside viewport (4px margin) so the menu never opens off-screen
  // when right-clicking near a panel edge.
  const PAD = 4;
  const visibleItems = items.length;
  const menuH = visibleItems * ITEM_H + 8;
  const left = Math.max(PAD, Math.min(x, window.innerWidth - MENU_W - PAD));
  const top = Math.max(PAD, Math.min(y, window.innerHeight - menuH - PAD));

  return (
    <div
      ref={ref}
      role="menu"
      style={{
        position: 'fixed', left, top, zIndex: 9999,
        minWidth: MENU_W,
        backgroundColor: 'var(--panel-bg-elev)',
        border: '1px solid var(--panel-border)',
        borderRadius: 'var(--radius-md)',
        padding: '4px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
        display: 'flex', flexDirection: 'column', gap: '1px',
        animation: 'mt-fade-in 100ms ease-out both',
      }}
    >
      {items.map((it) => (
        <div key={it.id}>
          {it.divider && <div style={{ height: 1, margin: '3px 4px', backgroundColor: 'var(--panel-border)' }} />}
          <button
            role="menuitem"
            disabled={it.disabled}
            onClick={() => { if (!it.disabled) { it.onSelect(); onClose(); } }}
            style={{
              width: '100%', textAlign: 'left',
              background: 'none', border: 'none',
              color: it.disabled ? 'var(--panel-fg-dim)' : 'var(--panel-fg)',
              padding: '6px 10px',
              fontSize: '12px',
              borderRadius: 'var(--radius-sm)',
              cursor: it.disabled ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: '8px',
            }}
            onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.backgroundColor = 'var(--panel-bg-sunken)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
          >
            {it.icon !== undefined && <span style={{ width: 14, fontSize: 12, opacity: 0.8 }}>{it.icon}</span>}
            <span>{it.label}</span>
          </button>
        </div>
      ))}
    </div>
  );
}
