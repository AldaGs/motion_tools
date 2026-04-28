// src/components/CommandPalette.tsx
import React, { useState, useEffect, useRef, useMemo } from 'react';
import * as icons from 'lucide-react';
import type { Macro, Profile } from '../types';
import { sanitizeSvg } from '../utils/svg';

interface CommandPaletteProps {
  profiles: Profile[];
  onExecute: (macro: Macro) => void;
  onClose: () => void;
}

/** Simple fuzzy match: every character of the query appears in order in the target. */
function fuzzyMatch(query: string, target: string): { match: boolean; score: number } {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatchIdx = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Consecutive matches score higher
      score += (ti === lastMatchIdx + 1) ? 2 : 1;
      // Word-boundary bonus
      if (ti === 0 || t[ti - 1] === ' ' || t[ti - 1] === '-') score += 3;
      lastMatchIdx = ti;
      qi++;
    }
  }

  return { match: qi === q.length, score };
}

export default function CommandPalette({ profiles, onExecute, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Flatten all macros from all profiles with their profile name for context
  const allMacros = useMemo(() => {
    // Deduplicate by ID to prevent "multiple copies" bug if profiles overlap
    const seen = new Set<string>();
    const result: { macro: Macro; profileName: string }[] = [];
    for (const profile of profiles) {
      for (const macro of profile.macros) {
        if (seen.has(macro.id)) continue;
        seen.add(macro.id);
        result.push({ macro, profileName: profile.name });
      }
    }
    return result;
  }, [profiles]);

  // Filter and sort by fuzzy match score
  const filtered = useMemo(() => {
    if (!query.trim()) return allMacros;
    return allMacros
      .map((item) => {
        const labelMatch = fuzzyMatch(query, item.macro.label);
        const tagMatch = (item.macro.tags ?? []).reduce(
          (best, tag) => {
            const m = fuzzyMatch(query, tag);
            return m.score > best.score ? m : best;
          },
          { match: false, score: 0 }
        );
        const profileMatch = fuzzyMatch(query, item.profileName);
        const bestScore = Math.max(labelMatch.score, tagMatch.score, profileMatch.score);
        const anyMatch = labelMatch.match || tagMatch.match || profileMatch.match;
        return { ...item, score: bestScore, match: anyMatch };
      })
      .filter((item) => item.match)
      .sort((a, b) => b.score - a.score);
  }, [query, allMacros]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIdx(0);
  }, [filtered.length]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIdx]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && filtered.length > 0) {
      e.preventDefault();
      onExecute(filtered[selectedIdx].macro);
      onClose();
    }
  };

  const renderIcon = (icon?: string) => {
    if (!icon) return null;
    if (icon.startsWith('<svg')) {
      return <div dangerouslySetInnerHTML={{ __html: sanitizeSvg(icon) }} style={{ width: 16, height: 16, flexShrink: 0 }} />;
    }
    const IconComp = (icons as any)[icon];
    if (IconComp) return <IconComp size={16} style={{ flexShrink: 0 }} />;
    // Assume emoji
    return <span style={{ fontSize: 14, flexShrink: 0 }}>{icon}</span>;
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        backgroundColor: 'rgba(0,0,0,0.5)',
        display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
        paddingTop: '60px',
        animation: 'mt-fade-in 120ms ease-out both',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: '340px',
          backgroundColor: 'var(--panel-bg)',
          border: '1px solid var(--panel-border)',
          borderRadius: 'var(--radius-lg, 12px)',
          boxShadow: '0 16px 48px rgba(0,0,0,0.4)',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          animation: 'mt-modal-in 180ms ease-out both',
        }}
      >
        {/* Search input */}
        <div style={{ padding: '12px 12px 8px' }}>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search macros…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            style={{
              width: '100%', padding: '10px 12px',
              backgroundColor: 'var(--panel-bg-sunken)',
              color: 'var(--panel-fg)',
              border: '1px solid var(--panel-border)',
              borderRadius: 'var(--radius-md)',
              fontSize: '14px',
              outline: 'none',
            }}
          />
        </div>

        {/* Results list */}
        <div
          ref={listRef}
          className="no-scrollbar"
          style={{
            maxHeight: '280px', overflowY: 'auto',
            padding: '0 6px 8px',
          }}
        >
          {filtered.length === 0 && (
            <div style={{ padding: '16px', textAlign: 'center', color: 'var(--panel-fg-dim)', fontSize: '12px' }}>
              No macros found
            </div>
          )}
          {filtered.map((item, idx) => (
            <div
              key={item.macro.id}
              onClick={() => { onExecute(item.macro); onClose(); }}
              onMouseEnter={() => setSelectedIdx(idx)}
              style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                cursor: 'pointer',
                backgroundColor: idx === selectedIdx ? 'var(--accent)' : 'transparent',
                color: idx === selectedIdx ? '#fff' : 'var(--panel-fg)',
                transition: 'background-color 80ms',
              }}
            >
              <div style={{
                width: 24, height: 24,
                borderRadius: 'var(--radius-sm)',
                backgroundColor: item.macro.color + '40',
                border: `1px solid ${item.macro.color}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, fontSize: '12px',
              }}>
                {renderIcon(item.macro.icon)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.macro.label}
                </div>
                <div style={{
                  fontSize: '10px',
                  color: idx === selectedIdx ? 'rgba(255,255,255,0.7)' : 'var(--panel-fg-dim)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {item.profileName}
                </div>
              </div>
              {item.macro.hotkey && (
                <span style={{
                  fontSize: '10px', padding: '2px 6px',
                  backgroundColor: idx === selectedIdx ? 'rgba(255,255,255,0.2)' : 'var(--panel-bg-sunken)',
                  borderRadius: 'var(--radius-sm)',
                  color: idx === selectedIdx ? '#fff' : 'var(--panel-fg-muted)',
                  flexShrink: 0,
                }}>
                  {item.macro.hotkey}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
