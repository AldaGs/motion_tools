// src/MotionGifsSettings.tsx
//
// Floating (Modeless) settings panel for Motion GIFS. It owns every export
// option and live-saves each change to gifSettings.json; the main panel re-reads
// that file on focus / at export time. No IPC — the disk file is the contract.

import { useState } from 'react';
import { evalScript } from './utils/adobe';
import { loadGifSettings, saveGifSettings, type GifSettings } from './utils/storage';
import { GIF_TEMPLATES } from './utils/gifExport';
import { OpenCloudButton } from './components/OpenCloudButton';

export default function MotionGifsSettings() {
  const [s, setS] = useState<GifSettings>(() => loadGifSettings());

  // Single setter that persists on every change.
  const set = <K extends keyof GifSettings>(key: K, value: GifSettings[K]) => {
    setS((prev) => {
      const next = { ...prev, [key]: value };
      saveGifSettings(next);
      return next;
    });
  };

  const browseOutput = async () => {
    const res = await evalScript('var f = Folder.selectDialog("Output folder"); f ? f.fsName : "null"');
    if (res && res !== 'null') set('outputDir', res);
  };

  return (
    <div className="mg-settings" style={{ height: '100vh', overflowY: 'auto', color: 'var(--panel-fg)', fontSize: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Hide the scrollbar chrome; scrolling still works if the panel is
          resized below the content height. */}
      <style>{`.mg-settings{scrollbar-width:none;-ms-overflow-style:none;}.mg-settings::-webkit-scrollbar{width:0;height:0;display:none;}`}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>Motion GIFS — Settings</div>
        <OpenCloudButton />
      </div>

      <Field label="Template">
        <select value={s.templateIndex} onChange={(e) => set('templateIndex', +e.target.value)} style={input}>
          {GIF_TEMPLATES.map((t, i) => (
            <option key={i} value={i} style={{ background: 'var(--panel-bg-elev)' }}>{t.label}</option>
          ))}
        </select>
      </Field>

      <Field label="Output format">
        <select value={s.outputFormat} onChange={(e) => set('outputFormat', e.target.value as GifSettings['outputFormat'])} style={input}>
          <option value="gif" style={{ background: 'var(--panel-bg-elev)' }}>GIF</option>
          <option value="webm" style={{ background: 'var(--panel-bg-elev)' }}>WebM (VP9, alpha)</option>
          <option value="apng" style={{ background: 'var(--panel-bg-elev)' }}>APNG (animated PNG, alpha)</option>
        </select>
      </Field>

      <Field label="Output folder">
        <div style={{ display: 'flex', gap: 6 }}>
          <input readOnly value={s.outputDir} placeholder="Pick a folder…" style={{ ...input, flex: 1, minWidth: 0 }} />
          <button onClick={browseOutput} style={btn}>…</button>
        </div>
      </Field>

      {/* Size */}
      <Field label="Size">
        <div style={rowWrap}>
          <Radio checked={s.sizeMode === 'comp'} onChange={() => set('sizeMode', 'comp')} label="As comp" />
          <Radio checked={s.sizeMode === 'custom'} onChange={() => set('sizeMode', 'custom')} label="Width" />
          <input type="number" min={1} value={s.width} disabled={s.sizeMode !== 'custom'}
            onChange={(e) => set('width', Math.max(1, parseInt(e.target.value || '1', 10)))}
            style={{ ...input, width: 70, opacity: s.sizeMode === 'custom' ? 1 : 0.5 }} />
        </div>
      </Field>

      {/* Frame rate */}
      <Field label="Frame rate">
        <div style={rowWrap}>
          <Radio checked={s.fpsMode === 'comp'} onChange={() => set('fpsMode', 'comp')} label="As comp" />
          <Radio checked={s.fpsMode === 'custom'} onChange={() => set('fpsMode', 'custom')} label="Custom" />
          <input type="number" min={1} value={s.fps} disabled={s.fpsMode !== 'custom'}
            onChange={(e) => set('fps', Math.max(1, parseInt(e.target.value || '1', 10)))}
            style={{ ...input, width: 60, opacity: s.fpsMode === 'custom' ? 1 : 0.5 }} />
        </div>
      </Field>

      <Field label={`Quality — ${s.quality}`}>
        <input type="range" min={1} max={100} value={s.quality}
          onChange={(e) => set('quality', +e.target.value)} style={{ width: '100%' }} />
      </Field>

      <Check checked={s.loopForever} onChange={(v) => set('loopForever', v)} label="Loop forever" />
      <Check checked={s.keepFrames} onChange={(v) => set('keepFrames', v)} label="Keep intermediate frames" />

      <Check checked={s.renderInBackground} onChange={(v) => set('renderInBackground', v)}
        label="Render in background (keep editing)" />
      {s.renderInBackground && (
        <div style={{ fontSize: 10, color: 'var(--panel-fg-muted)', marginTop: -8, lineHeight: 1.4 }}>
          Renders via aerender so After Effects stays editable. The project is saved
          first and rendered from disk — edits made after you start won't be included.
        </div>
      )}

      <div style={{ height: 1, background: 'var(--panel-border)', margin: '2px 0' }} />
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--panel-fg-muted)' }}>After export</div>
      <Check checked={s.openFolder} onChange={(v) => set('openFolder', v)} label="Open output folder" />
      <Check checked={s.playAfter} onChange={(v) => set('playAfter', v)} label="Play the GIF" />
    </div>
  );
}

const input: React.CSSProperties = {
  padding: '6px 8px', fontSize: 12, borderRadius: 4,
  border: '1px solid var(--panel-border)', background: 'var(--panel-bg)', color: 'var(--panel-fg)',
};
const btn: React.CSSProperties = {
  padding: '0 10px', borderRadius: 4, border: '1px solid var(--panel-border)',
  background: 'var(--panel-bg-elev)', color: 'var(--panel-fg)', cursor: 'pointer',
};
const rowWrap: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--panel-fg-muted)' }}>{label}</span>
      {children}
    </div>
  );
}

function Radio({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
      <input type="radio" checked={checked} onChange={onChange} /> {label}
    </label>
  );
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}
