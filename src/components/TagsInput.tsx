// src/components/TagsInput.tsx
//
// Chip-style tag editor. Comma or Enter commits the buffer as a tag;
// Backspace on an empty buffer removes the last chip. Duplicates and empty
// strings are dropped on commit.

import { useState, useRef } from 'react';
import type { KeyboardEvent } from 'react';

interface TagsInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}

export default function TagsInput({ value, onChange, placeholder }: TagsInputProps) {
  const [buffer, setBuffer] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    if (value.includes(t)) { setBuffer(''); return; }
    onChange([...value, t]);
    setBuffer('');
  };

  const removeAt = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commit(buffer);
    } else if (e.key === 'Backspace' && buffer === '' && value.length > 0) {
      e.preventDefault();
      removeAt(value.length - 1);
    }
  };

  return (
    <div
      onClick={() => inputRef.current?.focus()}
      style={{
        flex: 1, minWidth: 0,
        display: 'flex', flexWrap: 'wrap', gap: '4px',
        padding: '4px 6px',
        backgroundColor: 'var(--panel-bg-sunken)',
        border: '1px solid var(--panel-border)',
        borderRadius: 'var(--radius-md)',
        cursor: 'text',
        minHeight: '28px',
        alignItems: 'center',
      }}
    >
      {value.map((tag, idx) => (
        <span
          key={`${tag}-${idx}`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '4px',
            padding: '2px 6px',
            backgroundColor: 'var(--panel-bg-elev)',
            border: '1px solid var(--panel-border)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '11px',
            color: 'var(--panel-fg)',
          }}
        >
          {tag}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); removeAt(idx); }}
            title="Remove tag"
            style={{
              background: 'none', border: 'none', padding: 0,
              color: 'var(--panel-fg-muted)', cursor: 'pointer',
              fontSize: '12px', lineHeight: 1,
            }}
          >×</button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        value={buffer}
        onChange={(e) => setBuffer(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commit(buffer)}
        placeholder={value.length === 0 ? (placeholder ?? 'Add tags (comma to add)…') : ''}
        style={{
          flex: 1, minWidth: '80px',
          background: 'transparent', border: 'none', outline: 'none',
          color: 'var(--panel-fg)', fontSize: '12px',
          padding: '2px 0',
        }}
      />
    </div>
  );
}
