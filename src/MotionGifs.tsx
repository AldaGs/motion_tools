// src/MotionGifs.tsx
//
// "Motion GIFS" main panel — deliberately minimal. It shows only the export
// actions, a progress bar, and a Settings button. Every option (template,
// output folder, size/fps, quality, loop, open-folder, play-after, …) lives in
// the floating settings panel (MotionGifsSettings) and is read from disk at
// export time via loadGifSettings().

import { useEffect, useRef, useState } from 'react';
import { evalScript, isCEPEnvironment } from './utils/adobe';
import { loadGifSettings, type GifSettings } from './utils/storage';
import {
  resolveBinaries, encodeRenderToGif, convertVideoToGif, probeVideo,
  revealFile, playFile, templateFilePath,
  type GifBinaries, type RenderResult,
} from './utils/gifExport';
import { toast } from './utils/toast';

const SETTINGS_EXT = 'com.motiontoolbar.panel.gifsettings';

const tempFramesDir = (): string => {
  const os = window.require('os');
  const path = window.require('path');
  return path.join(os.tmpdir(), 'MotionGifs', String(Date.now()));
};

export default function MotionGifs() {
  const [bins, setBins] = useState<GifBinaries | null>(null);
  const [settings, setSettings] = useState<GifSettings | null>(null);

  const [running, setRunning] = useState(false);
  const [percent, setPercent] = useState(0);
  const [status, setStatus] = useState('');
  const runningRef = useRef(false);

  useEffect(() => {
    if (!isCEPEnvironment()) return;
    try { setBins(resolveBinaries()); } catch (e) { console.error(e); }
    setSettings(loadGifSettings());
    // Re-read settings whenever the panel regains focus — the floating settings
    // panel live-saves to disk, so this picks up edits without any IPC.
    const onFocus = () => setSettings(loadGifSettings());
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const ready = !!bins?.ok && !!settings?.outputDir && !running;
  const missing = bins && !bins.ok;

  const onProgress = (p: { percent: number; message: string }) => {
    setPercent(p.percent);
    setStatus(p.message);
  };

  const afterExport = (s: GifSettings, output: string) => {
    if (s.openFolder) revealFile(output);
    if (s.playAfter) playFile(output);
    toast.info(`GIF saved: ${output}`);
  };

  const begin = (msg: string) => {
    runningRef.current = true;
    setRunning(true);
    setPercent(0);
    setStatus(msg);
  };
  const end = () => { runningRef.current = false; setRunning(false); };

  const openSettings = () => {
    if (typeof window.__adobe_cep__ !== 'undefined') {
      window.__adobe_cep__.requestOpenExtension(SETTINGS_EXT, '');
    } else {
      toast.error('Settings panel only works in the CEP environment.');
    }
  };

  // Primary: render the active comp via the host template, then encode.
  const handleExportComp = async () => {
    const s = loadGifSettings();
    if (!bins?.ok || runningRef.current || !s.outputDir) return;
    const path = window.require('path');

    begin('Rendering comp…');
    try {
      const req = JSON.stringify({ templateIndex: s.templateIndex, outputFolder: s.outputDir, templateFile: templateFilePath() });
      const raw = await evalScript(`giphRenderComp(${JSON.stringify(req)})`);
      let render: RenderResult;
      try { render = JSON.parse(raw); }
      catch { throw new Error(`Host render failed: ${raw}`); }
      if (!render.ok) throw new Error(render.error || 'Render failed.');

      const width = s.sizeMode === 'comp' ? render.width : s.width;
      const fps = s.fpsMode === 'comp' ? Math.round(render.frameRate) : s.fps;
      const output = path.join(s.outputDir, `${render.name}.gif`);

      await encodeRenderToGif(
        render,
        { output, width, fps, quality: s.quality, loop: s.loopForever ? 0 : -1, keepFrames: s.keepFrames },
        onProgress,
      );
      afterExport(s, output);
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message ? `Export failed — ${e.message.split('\n')[0]}` : 'Export failed.');
    } finally {
      end();
    }
  };

  // Secondary: convert an already-existing video file.
  const handleConvertVideo = async () => {
    const s = loadGifSettings();
    if (!bins?.ok || runningRef.current || !s.outputDir) return;
    const path = window.require('path');
    const res = await evalScript('var f = File.openDialog("Select a video"); f ? f.fsName : "null"');
    if (!res || res === 'null') return;

    begin('Probing video…');
    try {
      // Resolve "as comp" against the source video's native metadata.
      let width = s.width;
      let fps = s.fps;
      if (s.sizeMode === 'comp' || s.fpsMode === 'comp') {
        const meta = await probeVideo(res);
        if (s.sizeMode === 'comp' && meta.width) width = meta.width;
        if (s.fpsMode === 'comp' && meta.fps) fps = meta.fps;
      }

      const base = path.basename(res).replace(/\.[^.]+$/, '') || 'output';
      const output = path.join(s.outputDir, `${base}.gif`);

      setStatus('Starting…');
      await convertVideoToGif(
        res,
        { output, width, fps, quality: s.quality, loop: s.loopForever ? 0 : -1, keepFrames: s.keepFrames, tempDir: tempFramesDir() },
        onProgress,
      );
      afterExport(s, output);
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message ? `Convert failed — ${e.message.split('\n')[0]}` : 'Convert failed.');
    } finally {
      end();
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', color: 'var(--panel-fg)', fontSize: 12 }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--panel-border)', background: 'var(--panel-bg-sunken)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 700 }}>Motion GIFS</span>
        <button onClick={openSettings} title="Settings"
          style={{ padding: '4px 8px', fontSize: 12, borderRadius: 'var(--radius-sm)', border: '1px solid var(--panel-border)', background: 'var(--panel-bg-elev)', color: 'var(--panel-fg)', cursor: 'pointer' }}>
          ⚙️
        </button>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 12, padding: 16 }}>
        {missing && (
          <div style={{ padding: 10, borderRadius: 6, background: 'var(--danger)', color: '#fff', fontSize: 11 }}>
            Bundled binaries not found:
            {!bins!.ffmpegExists && ' ffmpeg'}{!bins!.gifskiExists && ' gifski'}.
            <br />Place them under <code>bin/win/</code> in the extension.
          </div>
        )}

        {settings && !settings.outputDir && !missing && (
          <div style={{ fontSize: 11, color: 'var(--panel-fg-muted)', textAlign: 'center' }}>
            Set an output folder in <button onClick={openSettings} style={{ background: 'none', border: 'none', color: 'var(--accent, #3498db)', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}>Settings</button> to enable export.
          </div>
        )}

        <button onClick={handleExportComp} disabled={!ready}
          style={{
            padding: '14px', fontSize: 14, fontWeight: 700, borderRadius: 6,
            border: '1px solid var(--panel-border)',
            background: ready ? 'var(--accent, #3498db)' : 'var(--panel-bg-elev)',
            color: ready ? '#fff' : 'var(--panel-fg-dim)',
            cursor: ready ? 'pointer' : 'not-allowed',
          }}>
          {running ? 'Working…' : 'Export Active Comp → GIF'}
        </button>

        <button onClick={handleConvertVideo} disabled={!ready}
          style={{
            padding: '10px', fontSize: 12, borderRadius: 6, border: '1px solid var(--panel-border)',
            background: 'var(--panel-bg-elev)', color: 'var(--panel-fg)',
            cursor: ready ? 'pointer' : 'not-allowed', opacity: ready ? 1 : 0.6,
          }}>
          Convert Existing Video → GIF
        </button>
      </div>

      <div style={{ padding: 14, borderTop: '1px solid var(--panel-border)', background: 'var(--panel-bg-sunken)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ height: 8, borderRadius: 4, background: 'var(--panel-bg-elev)', overflow: 'hidden' }}>
          <div style={{ width: `${percent}%`, height: '100%', background: 'var(--accent, #3498db)', transition: 'width 120ms linear' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--panel-fg-muted)', minHeight: 12 }}>
          <span>{status}</span><span>{percent}%</span>
        </div>
      </div>
    </div>
  );
}
