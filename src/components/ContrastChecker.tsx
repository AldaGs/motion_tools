// WCAG contrast readout for a foreground/background pair. Seeded with the
// color currently being edited (the wheel's base); the "against" color is
// user-adjustable with quick white/black shortcuts, a native picker, and a
// swap. Shows the ratio plus AA/AAA pass badges for normal and large text.

import { useEffect, useState } from 'react';
import { wcagLevels } from '../utils/color';

const norm = (hex: string) => '#' + hex.replace(/^#/, '').toUpperCase();
const isHex = (hex: string) => /^#[0-9a-fA-F]{6}$/.test(hex);

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span style={{
      fontSize: '10px', fontWeight: 600, padding: '2px 6px', borderRadius: 'var(--radius-sm)',
      backgroundColor: ok ? 'var(--success)' : 'transparent',
      color: ok ? '#fff' : 'var(--panel-fg-dim)',
      border: `1px solid ${ok ? 'var(--success)' : 'var(--panel-border)'}`,
      whiteSpace: 'nowrap',
    }}>{label} {ok ? '✓' : '✗'}</span>
  );
}

export default function ContrastChecker({ foreground, swatches = [] }: { foreground: string; swatches?: string[] }) {
  const [against, setAgainst] = useState('#FFFFFF');
  const [swapped, setSwapped] = useState(false);

  // Dedup the harmony swatches (case-insensitive) so the quick-pick row doesn't
  // show the same color twice.
  const picks = swatches.reduce<string[]>((acc, c) => {
    const h = norm(c);
    if (isHex(h) && !acc.some((x) => x.toUpperCase() === h.toUpperCase())) acc.push(h);
    return acc;
  }, []);

  // Keep a valid pair even while the base color is mid-edit.
  const fg = isHex(foreground) ? norm(foreground) : '#000000';
  const [textHex, bgHex] = swapped ? [against, fg] : [fg, against];

  const r = wcagLevels(textHex, bgHex);
  const ratioStr = r.ratio.toFixed(2);

  // Keep the "against" swatch in sync if the user typed an invalid value away.
  useEffect(() => { if (!isHex(against)) setAgainst('#FFFFFF'); }, [against]);

  const btn: React.CSSProperties = {
    fontSize: '11px', padding: '3px 7px', cursor: 'pointer', borderRadius: 'var(--radius-sm)',
    backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)', border: '1px solid var(--panel-border)',
  };

  return (
    <div className="mc-card" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--panel-fg-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Contrast
        </span>
        <span style={{ fontSize: '15px', fontWeight: 700, color: r.normalAA ? 'var(--success)' : r.largeAA ? 'var(--panel-fg)' : 'var(--danger)' }}>
          {ratioStr}:1
        </span>
      </div>

      {/* Live preview */}
      <div style={{
        backgroundColor: bgHex, color: textHex, borderRadius: 'var(--radius-md)',
        border: '1px solid var(--panel-border)', padding: '10px 12px',
        display: 'flex', flexDirection: 'column', gap: '2px',
      }}>
        <span style={{ fontSize: '16px', fontWeight: 700 }}>Large text sample</span>
        <span style={{ fontSize: '12px' }}>Normal body text sample — the quick brown fox.</span>
      </div>

      {/* Badges */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
        <span style={{ fontSize: '10px', color: 'var(--panel-fg-dim)', width: 44 }}>Normal</span>
        <Badge ok={r.normalAA} label="AA" />
        <Badge ok={r.normalAAA} label="AAA" />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
        <span style={{ fontSize: '10px', color: 'var(--panel-fg-dim)', width: 44 }}>Large</span>
        <Badge ok={r.largeAA} label="AA" />
        <Badge ok={r.largeAAA} label="AAA" />
      </div>

      {/* "Against" controls */}
      <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
        <span style={{ fontSize: '10px', color: 'var(--panel-fg-dim)', flexShrink: 0 }}>vs</span>
        <input type="color" value={isHex(against) ? against.toLowerCase() : '#ffffff'} onChange={(e) => setAgainst(norm(e.target.value))}
          title="Pick the color to check against"
          style={{ width: 26, height: 26, padding: 0, border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-sm)', backgroundColor: 'transparent', cursor: 'pointer', flexShrink: 0 }} />
        <button style={btn} onClick={() => setAgainst('#FFFFFF')} title="Check against white">White</button>
        <button style={btn} onClick={() => setAgainst('#000000')} title="Check against black">Black</button>
        <button style={btn} onClick={() => setSwapped((v) => !v)} title="Swap text / background">⇅ Swap</button>
      </div>

      {/* Quick-pick the "against" color from the current harmony. */}
      {picks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '10px', color: 'var(--panel-fg-dim)' }}>Against harmony</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {picks.map((hex) => {
              const selected = against.toUpperCase() === hex.toUpperCase();
              return (
                <button key={hex} onClick={() => setAgainst(hex)} title={`Check against ${hex}`}
                  style={{
                    width: 24, height: 24, padding: 0, cursor: 'pointer', backgroundColor: hex,
                    borderRadius: 'var(--radius-sm)',
                    border: selected ? '2px solid var(--panel-fg)' : '1px solid rgba(0,0,0,0.3)',
                    boxShadow: selected ? '0 0 0 1px var(--panel-bg)' : 'none',
                  }} />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
