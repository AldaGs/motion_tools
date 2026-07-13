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
  renderInBackground, revealFile, playFile, openFolder, templateFilePath, outputExtForFormat,
  versionedOutputPath,
  type GifBinaries, type RenderResult, type BackgroundRenderPrep,
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
    const name = window.require('path').basename(output);
    toast.info(`Saved ${name}`);
  };

  // Manually reveal the configured output folder in Explorer/Finder.
  const openOutputFolder = () => {
    const dir = settings?.outputDir;
    if (dir) openFolder(dir);
    else toast.error('Set an output folder in Settings first.');
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

  // Primary: render the active comp via the host template, then encode. In
  // background mode aerender does the render (AE stays editable) and owns the
  // first half of the bar; otherwise the blocking render queue is used.
  const handleExportComp = async () => {
    const s = loadGifSettings();
    if (!bins?.ok || runningRef.current || !s.outputDir) return;
    const path = window.require('path');

    // Intermediates go to a throwaway OS temp folder (auto-removed after
    // encoding) unless the user wants to keep them, in which case they land in
    // a GIPHERrender subfolder next to the output. Either way the output folder
    // only receives the final .gif when discarding.
    const os = window.require('os');
    const fs = window.require('fs');
    const renderFolder = s.keepFrames
      ? path.join(s.outputDir, 'GIPHERrender')
      : path.join(os.tmpdir(), 'MotionGifs', String(Date.now()));
    try { fs.mkdirSync(renderFolder, { recursive: true }); } catch { /* host will retry */ }

    begin(s.renderInBackground ? 'Preparing background render…' : 'Rendering comp…');
    try {
      const req = JSON.stringify({ templateIndex: s.templateIndex, renderFolder, templateFile: templateFilePath() });
      let render: RenderResult;
      let encodeBase = 0; // % the encode phase starts at

      if (s.renderInBackground) {
        const raw = await evalScript(`giphPrepareBackgroundRender(${JSON.stringify(req)})`);
        let prep: BackgroundRenderPrep;
        try { prep = JSON.parse(raw); }
        catch { throw new Error(`Host prep failed: ${raw}`); }
        if (!prep.ok) throw new Error(prep.error || 'Background render prep failed.');

        // aerender owns 0–50%.
        render = await renderInBackground(prep, (frac, message) =>
          onProgress({ percent: Math.round(frac * 50), message }));
        encodeBase = 50;
      } else {
        const raw = await evalScript(`giphRenderComp(${JSON.stringify(req)})`);
        try { render = JSON.parse(raw); }
        catch { throw new Error(`Host render failed: ${raw}`); }
        if (!render.ok) throw new Error(render.error || 'Render failed.');
      }

      const width = s.sizeMode === 'comp' ? render.width : s.width;
      const fps = s.fpsMode === 'comp' ? Math.round(render.frameRate) : s.fps;
      const output = versionedOutputPath(s.outputDir, render.name, outputExtForFormat(s.outputFormat), s.overwrite);

      // When aerender took the first half, remap encode progress into 50–100%.
      const encodeProgress = encodeBase
        ? (p: { percent: number; message: string }) => onProgress({ percent: encodeBase + Math.round(p.percent / 2), message: p.message })
        : onProgress;

      await encodeRenderToGif(
        render,
        { output, width, fps, quality: s.quality, loop: s.loopForever ? 0 : -1, keepFrames: s.keepFrames, format: s.outputFormat },
        encodeProgress,
      );
      afterExport(s, output);
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message ? `Export failed — ${e.message.split('\n')[0]}` : 'Export failed.');
    } finally {
      end();
    }
  };

  // Batch: render + encode every comp selected in the Project panel, one after
  // another, into the output folder. Always uses the blocking render path (the
  // background/aerender flow is single-comp only). One shared progress bar is
  // split evenly across the comps.
  const handleBatchExport = async () => {
    const s = loadGifSettings();
    if (!bins?.ok || runningRef.current || !s.outputDir) return;
    const path = window.require('path');
    const os = window.require('os');
    const fs = window.require('fs');

    let comps: Array<{ id: number; name: string }> = [];
    try {
      const parsed = JSON.parse(await evalScript('giphSelectedComps()'));
      if (!parsed.ok) throw new Error(parsed.error || 'Could not read selection.');
      comps = parsed.comps || [];
    } catch (e: any) {
      toast.error(e?.message ? `Batch failed — ${e.message}` : 'Batch failed.');
      return;
    }
    if (comps.length === 0) {
      toast.error('Select one or more comps in the Project panel first.');
      return;
    }

    const total = comps.length;
    const ext = outputExtForFormat(s.outputFormat);
    begin(`Batch export — 0/${total}…`);
    let lastOutput = '';
    try {
      for (let i = 0; i < total; i++) {
        const c = comps[i];
        const renderFolder = s.keepFrames
          ? path.join(s.outputDir, 'GIPHERrender')
          : path.join(os.tmpdir(), 'MotionGifs', `${Date.now()}_${i}`);
        try { fs.mkdirSync(renderFolder, { recursive: true }); } catch { /* host will retry */ }

        const req = JSON.stringify({ templateIndex: s.templateIndex, renderFolder, templateFile: templateFilePath(), compId: c.id });
        setStatus(`(${i + 1}/${total}) Rendering ${c.name}…`);
        let render: RenderResult;
        const raw = await evalScript(`giphRenderComp(${JSON.stringify(req)})`);
        try { render = JSON.parse(raw); }
        catch { throw new Error(`Host render failed: ${raw}`); }
        if (!render.ok) throw new Error(render.error || `Render failed for ${c.name}.`);

        const width = s.sizeMode === 'comp' ? render.width : s.width;
        const fps = s.fpsMode === 'comp' ? Math.round(render.frameRate) : s.fps;
        lastOutput = versionedOutputPath(s.outputDir, render.name, ext, s.overwrite);

        // Map this comp's 0–100 encode into its slice of the overall bar.
        const sliceBase = (i / total) * 100;
        await encodeRenderToGif(
          render,
          { output: lastOutput, width, fps, quality: s.quality, loop: s.loopForever ? 0 : -1, keepFrames: s.keepFrames, format: s.outputFormat },
          (p) => onProgress({ percent: Math.round(sliceBase + p.percent / total), message: `(${i + 1}/${total}) ${p.message}` }),
        );
      }
      setPercent(100);
      if (s.openFolder && lastOutput) revealFile(lastOutput);
      toast.info(`Batch export complete — ${total} file(s) saved`);
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message ? `Batch failed — ${e.message.split('\n')[0]}` : 'Batch failed.');
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
      const output = versionedOutputPath(s.outputDir, base, outputExtForFormat(s.outputFormat), s.overwrite);

      setStatus('Starting…');
      await convertVideoToGif(
        res,
        { output, width, fps, quality: s.quality, loop: s.loopForever ? 0 : -1, keepFrames: s.keepFrames, format: s.outputFormat, tempDir: tempFramesDir() },
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
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6, padding: 8 }}>
        {missing && (
          <div style={{ padding: 8, borderRadius: 4, background: 'var(--danger)', color: '#fff', fontSize: 10 }}>
            Missing binaries:{!bins!.ffmpegExists && ' ffmpeg'}{!bins!.gifskiExists && ' gifski'} — add under <code>bin/win/</code>.
          </div>
        )}

        {settings && !settings.outputDir && !missing && (
          <div style={{ fontSize: 10, color: 'var(--panel-fg-muted)', textAlign: 'center' }}>
            Set an output folder in Settings to enable export.
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
          <button onClick={handleExportComp} disabled={!ready}
            style={{
              flex: 1, padding: '7px 8px', fontSize: 12, fontWeight: 700, borderRadius: 4,
              border: '1px solid var(--panel-border)',
              background: ready ? 'var(--accent, #3498db)' : 'var(--panel-bg-elev)',
              color: ready ? '#fff' : 'var(--panel-fg-dim)',
              cursor: ready ? 'pointer' : 'not-allowed',
            }}>
            {running ? 'Working…' : 'Export Active Comp'}
          </button>
          <button onClick={openOutputFolder} title="Open output folder"
            disabled={!settings?.outputDir}
            style={{ padding: '0 8px', fontSize: 12, borderRadius: 4, border: '1px solid var(--panel-border)', background: 'var(--panel-bg-elev)', color: 'var(--panel-fg)', cursor: settings?.outputDir ? 'pointer' : 'not-allowed', opacity: settings?.outputDir ? 1 : 0.5 }}>
            📂
          </button>
          <button onClick={openSettings} title="Settings"
            style={{ padding: '0 8px', fontSize: 12, borderRadius: 4, border: '1px solid var(--panel-border)', background: 'var(--panel-bg-elev)', color: 'var(--panel-fg)', cursor: 'pointer' }}>
            ⚙️
          </button>
        </div>

        <button onClick={handleBatchExport} disabled={!ready}
          title="Render every comp selected in the Project panel"
          style={{
            padding: '6px 8px', fontSize: 11, borderRadius: 4, border: '1px solid var(--panel-border)',
            background: 'var(--panel-bg-elev)', color: 'var(--panel-fg)',
            cursor: ready ? 'pointer' : 'not-allowed', opacity: ready ? 1 : 0.6,
          }}>
          Batch Export Selected Comps
        </button>

        <button onClick={handleConvertVideo} disabled={!ready}
          style={{
            padding: '6px 8px', fontSize: 11, borderRadius: 4, border: '1px solid var(--panel-border)',
            background: 'var(--panel-bg-elev)', color: 'var(--panel-fg)',
            cursor: ready ? 'pointer' : 'not-allowed', opacity: ready ? 1 : 0.6,
          }}>
          Convert Existing Video
        </button>
      </div>

      <div style={{ padding: 8, borderTop: '1px solid var(--panel-border)', background: 'var(--panel-bg-sunken)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ height: 6, borderRadius: 3, background: 'var(--panel-bg-elev)', overflow: 'hidden' }}>
          <div style={{ width: `${percent}%`, height: '100%', background: 'var(--accent, #3498db)', transition: 'width 120ms linear' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--panel-fg-muted)', minHeight: 11 }}>
          <span>{status}</span><span>{percent}%</span>
        </div>
      </div>
    </div>
  );
}
