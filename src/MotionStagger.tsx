// src/MotionStagger.tsx
//
// The "Stagger" tool that lives in the locked Helpers profile. Cascades the
// in-points of selected layers (or the times of selected keyframes) in the
// timeline. Host logic: mtagStagger / mtagStaggerArrange in jsx/hostscript.jsx.

import { evalScript } from './utils/adobe';
import { toast } from './utils/toast';
import type { StaggerSettings, StaggerType } from './types';

interface Props {
  value: StaggerSettings;
  onChange: (next: StaggerSettings) => void;
}

const TYPE_ORDER: StaggerType[] = ['tb', 'bt', 'random'];
const TYPE_LABEL: Record<StaggerType, string> = {
  tb: 'Top → Bottom',
  bt: 'Bottom → Top',
  random: 'Random',
};

// A tiny 3-row glyph whose highlighted row hints at the cascade direction.
const TypeIcon = ({ type }: { type: StaggerType }) => {
  const rows = type === 'random' ? [1, 2, 0] : type === 'bt' ? [2, 1, 0] : [0, 1, 2];
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      {rows.map((shade, i) => (
        <rect
          key={i}
          x={2 + shade * 3.2}
          y={2 + i * 4.4}
          width="12"
          height="3"
          rx="1"
          fill="currentColor"
          opacity={type === 'random' ? 0.55 + 0.15 * i : 0.35 + 0.32 * i}
        />
      ))}
    </svg>
  );
};

// Report a host result string the same way App.handleMacroClick does.
const reportResult = (result: string) => {
  if (typeof result !== 'string') return;
  if (result.indexOf('Error:') === 0) toast.error(result.slice(6).trim());
  else if (result.indexOf('Warning:') === 0) toast.info(result.slice(8).trim());
};

const callHost = async (fn: string, opts: unknown) => {
  // Double-stringify so the JSON travels as a properly escaped ExtendScript
  // string literal (matches the executeAction call convention).
  const literal = JSON.stringify(JSON.stringify(opts));
  const result = await evalScript(`${fn}(${literal})`);
  reportResult(result);
};

export default function MotionStagger({ value, onChange }: Props) {
  const cycleType = () => {
    const idx = TYPE_ORDER.indexOf(value.type);
    onChange({ ...value, type: TYPE_ORDER[(idx + 1) % TYPE_ORDER.length] });
  };

  const runStagger = () =>
    callHost('mtagStagger', { type: value.type, offset: value.offset, step: value.step });

  const runArrange = (e: React.MouseEvent) => {
    const target = e.altKey ? 'compStart' : e.shiftKey ? 'firstInPoint' : 'cti';
    callHost('mtagStaggerArrange', { target });
  };

  const num = (v: string, min: number) => {
    const n = parseInt(v, 10);
    return isNaN(n) ? min : Math.max(min, n);
  };

  const btn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
    padding: '0 10px', height: '30px', flexShrink: 0,
    backgroundColor: 'var(--panel-bg-sunken)', color: 'var(--panel-fg)',
    border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-md)',
    cursor: 'pointer', fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em',
  };
  const iconBtn: React.CSSProperties = { ...btn, width: '34px', padding: 0 };
  const fieldWrap: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '2px', flexShrink: 0 };
  const fieldLabel: React.CSSProperties = { fontSize: '9px', color: 'var(--panel-fg-dim)', textTransform: 'uppercase', letterSpacing: '0.06em', paddingLeft: '2px' };
  const input: React.CSSProperties = {
    width: '46px', height: '30px', textAlign: 'center', boxSizing: 'border-box',
    backgroundColor: 'var(--panel-bg)', color: 'var(--panel-fg)',
    border: '1px solid var(--panel-border)', borderRadius: 'var(--radius-md)', fontSize: '12px',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '14px' }}>
      <span style={{ fontSize: '10px', color: 'var(--panel-fg-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Stagger</span>
      {/* Everything wraps instead of scrolling: actions and number fields flow
          onto extra rows in narrow panels rather than clipping. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '6px' }}>
        <button
          style={{ ...btn, flex: '1 1 88px', minWidth: '72px' }}
          onClick={runStagger}
          title="Cascade selected layers / keyframes in time"
        >
          SEQUENCE
        </button>
        <button
          style={iconBtn}
          onClick={runArrange}
          title={'Align in-points to the playhead\nAlt: comp start · Shift: first in-point'}
        >
          {/* stacked → aligned bars */}
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <rect x="2" y="3" width="7" height="2.4" rx="1" fill="currentColor" />
            <rect x="2" y="7" width="11" height="2.4" rx="1" fill="currentColor" opacity="0.75" />
            <rect x="2" y="11" width="5" height="2.4" rx="1" fill="currentColor" opacity="0.55" />
          </svg>
        </button>
        <button style={iconBtn} onClick={cycleType} title={`Order: ${TYPE_LABEL[value.type]} (click to change)`}>
          <TypeIcon type={value.type} />
        </button>
        <div style={fieldWrap}>
          <span style={fieldLabel}>offset</span>
          <input
            style={input}
            type="number"
            value={value.offset}
            onChange={(e) => onChange({ ...value, offset: num(e.target.value, 0) })}
            title="Frames between successive elements"
          />
        </div>
        <div style={fieldWrap}>
          <span style={fieldLabel}>step</span>
          <input
            style={input}
            type="number"
            min={1}
            value={value.step}
            onChange={(e) => onChange({ ...value, step: num(e.target.value, 1) })}
            title="Elements per step (1 = every element)"
          />
        </div>
      </div>
    </div>
  );
}
