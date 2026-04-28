// src/components/ConfirmDialog.tsx
//
// In-app replacement for window.confirm. CEP's native confirm is unstyled and
// can occasionally lock the CEF panel; rendering inside React keeps everything
// theme-aware and non-blocking.

import { useEffect, useRef } from 'react';

interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open, title, message,
  confirmLabel = 'OK', cancelLabel = 'Cancel',
  destructive = false,
  onConfirm, onCancel,
}: ConfirmDialogProps) {
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    confirmBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onConfirm, onCancel]);

  if (!open) return null;

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        backgroundColor: 'rgba(0,0,0,0.5)',
        display: 'flex', justifyContent: 'center', alignItems: 'center',
        animation: 'mt-fade-in 120ms ease-out both',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{
          width: '100%', maxWidth: '320px', margin: '0 16px',
          backgroundColor: 'var(--panel-bg)',
          border: '1px solid var(--panel-border)',
          borderRadius: 'var(--radius-lg, 12px)',
          boxShadow: '0 16px 48px rgba(0,0,0,0.4)',
          padding: '16px',
          display: 'flex', flexDirection: 'column', gap: '12px',
          animation: 'mt-modal-in 180ms ease-out both',
        }}
      >
        {title && (
          <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--panel-fg)' }}>
            {title}
          </div>
        )}
        <div style={{ fontSize: '12px', color: 'var(--panel-fg-muted)', lineHeight: 1.5 }}>
          {message}
        </div>
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '4px' }}>
          <button
            onClick={onCancel}
            style={{
              padding: '6px 14px', fontSize: '12px',
              backgroundColor: 'var(--panel-bg-elev)',
              color: 'var(--panel-fg)',
              border: '1px solid var(--panel-border)',
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
            }}
          >{cancelLabel}</button>
          <button
            ref={confirmBtnRef}
            onClick={onConfirm}
            style={{
              padding: '6px 14px', fontSize: '12px', fontWeight: 600,
              backgroundColor: destructive ? 'var(--danger)' : 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
            }}
          >{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
