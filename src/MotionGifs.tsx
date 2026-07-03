// src/MotionGifs.tsx
//
// "Motion GIFS" panel — a CEP port of the GIPHER ScriptUI script.
//
// Primary flow: pick an output-module template + folder, hit Export. The host
// script (giphRenderComp) renders the active comp with the bundled template and
// returns a result; Node then runs the ffmpeg/gifski pipeline (utils/gifExport)
// and drives the 0–100 progress bar. A secondary "Convert video" flow feeds an
// arbitrary existing video through the same encoder.

import { useEffect, useMemo, useRef, useState } from 'react';
import { evalScript, isCEPEnvironment } from './utils/adobe';
import {
  resolveBinaries, encodeRenderToGif, convertVideoToGif, templateFilePath,
  GIF_TEMPLATES, type GifBinaries, type RenderResult,
} from './utils/gifExport';
import { toast } from './utils/toast';

const tempFramesDir = (): string => {
  const os = window.require('os');
  const path = window.require('path');
  return path.join(os.tmpdir(), 'MotionGifs', String(Date.now()));
};

export default function MotionGifs() {
  const [bins, setBins] = useState<GifBinaries | null>(null);
  const [templateIndex, setTemplateIndex] = useState(0);
  const [outputDir, setOutputDir] = useState('');
  const [width, setWidth] = useState(540);
  const [fps, setFps] = useState(12);
  const [quality, setQuality] = useState(70);
  const [loopForever, setLoopForever] = useState(true);
  const [keepFrames, setKeepFrames] = useState(false);

  const [running, setRunning] = useState(false);
  const [percent, setPercent] = useState(0);
  const [status, setStatus] = useState('');
  const runningRef = useRef(false);

  useEffect(() => {
    if (!isCEPEnvironment()) return;
    try { setBins(resolveBinaries()); } catch (e) { console.error(e); }
  }, []);

  const canExport = useMemo(
    () => !!bins?.ok && !!outputDir && !running,
    [bins, outputDir, running],
  );

  const browseOutput = async () => {
    const res = await evalScript('var f = Folder.selectDialog("Output folder"); f ? f.fsName : "null"');
    if (res && res !== 'null') setOutputDir(res);
  };

  const onProgress = (p: { percent: number; message: string }) => {
    setPercent(p.percent);
    setStatus(p.message);
  };

  // Primary: render the active comp via the host template, then encode.
  const handleExportComp = async () => {
    if (!bins?.ok || runningRef.current || !outputDir) return;
    const path = window.require('path');

    runningRef.current = true;
    setRunning(true);
    setPercent(0);
    setStatus('Rendering comp…');
    try {
      const req = JSON.stringify({ templateIndex, outputFolder: outputDir, templateFile: templateFilePath() });
      const raw = await evalScript(`giphRenderComp(${JSON.stringify(req)})`);
      let render: RenderResult;
      try { render = JSON.parse(raw); }
      catch { throw new Error(`Host render failed: ${raw}`); }
      if (!render.ok) throw new Error(render.error || 'Render failed.');

      const output = path.join(outputDir, `${render.name}.gif`);
      await encodeRenderToGif(
        render,
        { output, width, fps, quality, loop: loopForever ? 0 : -1, keepFrames },
        onProgress,
      );
      toast.info(`GIF saved: ${output}`);
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message ? `Export failed — ${e.message.split('\n')[0]}` : 'Export failed.');
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  // Secondary: convert an already-existing video file.
  const handleConvertVideo = async () => {
    if (!bins?.ok || runningRef.current || !outputDir) return;
    const path = window.require('path');
    const res = await evalScript('var f = File.openDialog("Select a video"); f ? f.fsName : "null"');
    if (!res || res === 'null') return;

    const base = path.basename(res).replace(/\.[^.]+$/, '') || 'output';
    const output = path.join(outputDir, `${base}.gif`);

    runningRef.current = true;
    setRunning(true);
    setPercent(0);
    setStatus('Starting…');
    try {
      await convertVideoToGif(
        res,
        { output, width, fps, quality, loop: loopForever ? 0 : -1, keepFrames, tempDir: tempFramesDir() },
        onProgress,
      );
      toast.info(`GIF saved: ${output}`);
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message ? `Convert failed — ${e.message.split('\n')[0]}` : 'Convert failed.');
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  const missing = bins && !bins.ok;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', color: 'var(--panel-fg)', fontSize: 12 }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--panel-border)', background: 'var(--panel-bg-sunken)', fontWeight: 700 }}>
        Motion GIFS
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {missing && (
          <div style={{ padding: 10, borderRadius: 6, background: 'var(--danger)', color: '#fff', fontSize: 11 }}>
            Bundled binaries not found:
            {!bins!.ffmpegExists && ' ffmpeg'}{!bins!.gifskiExists && ' gifski'}.
            <br />Place them under <code>bin/win/</code> in the extension.
          </div>
        )}

        <Field label="Template">
          <select value={templateIndex} onChange={(e) => setTemplateIndex(+e.target.value)}
            style={{ width: '100%', padding: '6px 8px', fontSize: 12, borderRadius: 4, border: '1px solid var(--panel-border)', background: 'var(--panel-bg)', color: 'var(--panel-fg)' }}>
            {GIF_TEMPLATES.map((t, i) => (
              <option key={i} value={i} style={{ background: 'var(--panel-bg-elev)' }}>{t.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Output folder">
          <div style={{ display: 'flex', gap: 6 }}>
            <input readOnly value={outputDir} placeholder="Pick a folder…"
              style={{ flex: 1, minWidth: 0, padding: '6px 8px', fontSize: 11, borderRadius: 4, border: '1px solid var(--panel-border)', background: 'var(--panel-bg)', color: 'var(--panel-fg)' }} />
            <button onClick={browseOutput}
              style={{ padding: '0 10px', borderRadius: 4, border: '1px solid var(--panel-border)', background: 'var(--panel-bg-elev)', color: 'var(--panel-fg)', cursor: 'pointer' }}>…</button>
          </div>
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <NumField label="Width" value={width} min={1} onChange={setWidth} />
          <NumField label="FPS" value={fps} min={1} onChange={setFps} />
        </div>

        <Field label={`Quality — ${quality}`}>
          <input type="range" min={1} max={100} value={quality}
            onChange={(e) => setQuality(+e.target.value)} style={{ width: '100%' }} />
        </Field>

        <label style={checkRow}>
          <input type="checkbox" checked={loopForever} onChange={(e) => setLoopForever(e.target.checked)} />
          Loop forever
        </label>
        <label style={checkRow}>
          <input type="checkbox" checked={keepFrames} onChange={(e) => setKeepFrames(e.target.checked)} />
          Keep intermediate frames
        </label>

        <button onClick={handleConvertVideo} disabled={!canExport}
          style={{ marginTop: 4, padding: '8px', fontSize: 11, borderRadius: 6, border: '1px solid var(--panel-border)', background: 'var(--panel-bg-elev)', color: 'var(--panel-fg)', cursor: canExport ? 'pointer' : 'not-allowed', opacity: canExport ? 1 : 0.6 }}>
          Convert existing video…
        </button>
      </div>

      <div style={{ padding: 14, borderTop: '1px solid var(--panel-border)', background: 'var(--panel-bg-sunken)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ height: 8, borderRadius: 4, background: 'var(--panel-bg-elev)', overflow: 'hidden' }}>
          <div style={{ width: `${percent}%`, height: '100%', background: 'var(--accent, #3498db)', transition: 'width 120ms linear' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--panel-fg-muted)', minHeight: 12 }}>
          <span>{status}</span><span>{percent}%</span>
        </div>
        <button onClick={handleExportComp} disabled={!canExport}
          style={{
            padding: '10px', fontSize: 13, fontWeight: 700, borderRadius: 6,
            border: '1px solid var(--panel-border)',
            background: canExport ? 'var(--accent, #3498db)' : 'var(--panel-bg-elev)',
            color: canExport ? '#fff' : 'var(--panel-fg-dim)',
            cursor: canExport ? 'pointer' : 'not-allowed',
          }}>
          {running ? 'Working…' : 'Export active comp → GIF'}
        </button>
      </div>
    </div>
  );
}

const checkRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--panel-fg-muted)' }}>{label}</span>
      {children}
    </div>
  );
}

function NumField({ label, value, min, onChange }: { label: string; value: number; min: number; onChange: (n: number) => void }) {
  return (
    <Field label={label}>
      <input type="number" min={min} value={value}
        onChange={(e) => onChange(Math.max(min, parseInt(e.target.value || String(min), 10)))}
        style={{ width: '100%', padding: '6px 8px', fontSize: 12, borderRadius: 4, border: '1px solid var(--panel-border)', background: 'var(--panel-bg)', color: 'var(--panel-fg)' }} />
    </Field>
  );
}
