// src/utils/gifExport.ts
//
// Node-backed GIF export for the Motion GIFS panel. The host .jsx renders the
// active comp with a bundled output-module template and hands back a result;
// this module then drives ffmpeg/gifski (bundled under bin/<platform>/) and
// streams a single 0–100 progress value to the UI. Replaces GIPHER's legacy
// .bat/.vbs `.execute()` shell-out.
//
// Two render modes, mirroring GIPHER:
//   • 'png'    — AE rendered a PNG sequence → gifski encodes directly (no
//                ffmpeg). gifski owns the whole 0–100 bar. Preserves alpha.
//   • 'prores' — AE rendered a ProRes .mov → ffmpeg extracts scaled frames
//                (0–50%) → gifski encodes (50–100%).

declare global {
  interface Window {
    require: any;
    CSInterface: any;
    SystemPath: any;
  }
}

export interface GifBinaries {
  ffmpeg: string;
  gifski: string;
  ok: boolean;
  ffmpegExists: boolean;
  gifskiExists: boolean;
}

// The four output-module templates carried in templates/gipher_templates.aepx,
// in the order the host script's GIPH_TEMPLATES expects (index is passed to it).
export const GIF_TEMPLATES = [
  { label: 'PNG · RGB+A (alpha)', mode: 'png' as const },
  { label: 'PNG · RGB', mode: 'png' as const },
  { label: 'ProRes 4444 · RGB+A (alpha)', mode: 'prores' as const },
  { label: 'ProRes 422 · RGB', mode: 'prores' as const },
];

export interface EncodeOptions {
  /** Destination .gif path. */
  output: string;
  /** Output width in px; height derived to keep aspect (-1). */
  width: number;
  /** Output frame rate. */
  fps: number;
  /** gifski quality 1–100. */
  quality: number;
  /** gifski --repeat: 0 = loop forever, -1 = no loop, n = n times. */
  loop?: number;
  /** Keep intermediate frames on disk after encoding. */
  keepFrames?: boolean;
}

/** Result the host script returns from giphRenderComp(). */
export interface RenderResult {
  ok: boolean;
  error?: string;
  mode: 'png' | 'prores';
  /** Rendered path without extension: PNG frames are `${base}_*.png`, ProRes is `${base}.mov`. */
  base: string;
  /** The GIPHERrender subfolder holding the intermediate files. */
  folder: string;
  name: string;
  width: number;
  height: number;
  frameRate: number;
  duration: number;
}

export type GifProgress = {
  percent: number; // 0–100 overall
  phase: 'render' | 'extract' | 'encode';
  message: string;
};

const EXTRACT_WEIGHT = 0.5; // ffmpeg's share of the bar in ProRes mode.

const normalizeSystemPath = (raw: string | undefined | null): string => {
  if (!raw) return '';
  let s = String(raw);
  s = s.replace(/^file:\/{0,3}/i, '');
  try { s = decodeURIComponent(s); } catch { /* bad escapes — leave as-is */ }
  if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1);
  return s;
};

const extensionRoot = (): string => {
  const cs = new window.CSInterface();
  return normalizeSystemPath(cs.getSystemPath(window.SystemPath.EXTENSION));
};

const platformDir = (): string => {
  const os = window.require('os');
  return os.platform() === 'darwin' ? 'mac' : 'win';
};

const exeName = (base: string): string => (platformDir() === 'win' ? `${base}.exe` : base);

/** Absolute path to the bundled output-module template project. */
export const templateFilePath = (): string => {
  const path = window.require('path');
  return path.join(extensionRoot(), 'templates', 'gipher_templates.aepx');
};

/** Locate the bundled binaries and report whether each is present. */
export const resolveBinaries = (): GifBinaries => {
  const fs = window.require('fs');
  const path = window.require('path');

  const dir = path.join(extensionRoot(), 'bin', platformDir());
  const ffmpeg = path.join(dir, exeName('ffmpeg'));
  const gifski = path.join(dir, exeName('gifski'));

  const ffmpegExists = fs.existsSync(ffmpeg);
  const gifskiExists = fs.existsSync(gifski);

  if (platformDir() === 'mac') {
    for (const bin of [ffmpeg, gifski]) {
      try { if (fs.existsSync(bin)) fs.chmodSync(bin, 0o755); } catch { /* best effort */ }
    }
  }

  return { ffmpeg, gifski, ok: ffmpegExists && gifskiExists, ffmpegExists, gifskiExists };
};

// --- shared spawn helpers ---------------------------------------------------

const TIME_RE = /(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/;
const toSeconds = (hms: string): number => {
  const m = hms.match(TIME_RE);
  if (!m) return 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
};

// ffmpeg: scale + resample a source movie into PNG frames. Reports [0..1]*weight.
const ffmpegExtract = (
  ffmpeg: string,
  input: string,
  framePattern: string,
  width: number,
  fps: number,
  weight: number,
  onProgress: (p: GifProgress) => void,
): Promise<void> => {
  const { spawn } = window.require('child_process');
  return new Promise((resolve, reject) => {
    let duration = 0;
    let tail = '';
    const proc = spawn(ffmpeg, ['-y', '-i', input, '-vf', `scale=${width}:-1,fps=${fps}`, framePattern]);
    proc.stderr.on('data', (buf: any) => {
      const text = String(buf);
      tail = (tail + text).slice(-2000);
      if (!duration) {
        const d = text.match(/Duration:\s*([\d:.]+)/);
        if (d) duration = toSeconds(d[1]);
      }
      const t = text.match(/time=\s*([\d:.]+)/);
      if (t && duration > 0) {
        const done = Math.min(1, toSeconds(t[1]) / duration);
        onProgress({ phase: 'extract', percent: Math.round(done * weight * 100), message: `Extracting frames… ${Math.round(done * 100)}%` });
      }
    });
    proc.on('error', reject);
    proc.on('close', (code: number) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${tail}`))));
  });
};

// gifski: encode a sorted list of PNG frames into the final GIF. Reports
// progress mapped into [weightStart, weightStart+weightSpan].
const gifskiEncode = (
  gifski: string,
  frames: string[],
  opts: EncodeOptions,
  weightStart: number,
  weightSpan: number,
  onProgress: (p: GifProgress) => void,
): Promise<void> => {
  const { spawn } = window.require('child_process');
  return new Promise((resolve, reject) => {
    if (frames.length === 0) return reject(new Error('No frames were rendered.'));
    let tail = '';
    const args = [
      '-r', String(opts.fps),
      '-W', String(opts.width),
      '-Q', String(opts.quality),
      '--repeat', String(opts.loop ?? 0),
      '-o', opts.output,
    ].concat(frames);
    const proc = spawn(gifski, args);
    proc.stderr.on('data', (buf: any) => {
      const text = String(buf);
      tail = (tail + text).slice(-2000);
      const m = text.match(/(\d{1,3})\s*%/);
      if (m) {
        const done = Math.min(1, (+m[1]) / 100);
        onProgress({ phase: 'encode', percent: Math.round((weightStart + done * weightSpan) * 100), message: `Encoding GIF… ${Math.round(done * 100)}%` });
      }
    });
    proc.on('error', reject);
    proc.on('close', (code: number) => (code === 0 ? resolve() : reject(new Error(`gifski exited ${code}\n${tail}`))));
  });
};

// Collect a sorted PNG sequence AE wrote as `${prefix}_00000.png`, `_00001`, …
const collectSequence = (folder: string, prefix: string): string[] => {
  const fs = window.require('fs');
  const path = window.require('path');
  const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '_\\d+\\.png$');
  return fs
    .readdirSync(folder)
    .filter((f: string) => re.test(f))
    .sort()
    .map((f: string) => path.join(folder, f));
};

const cleanupFolder = (folder: string, keep?: boolean) => {
  if (keep) return;
  const fs = window.require('fs');
  const path = window.require('path');
  try {
    for (const f of fs.readdirSync(folder)) {
      if (/\.(png|mov)$/i.test(f)) fs.unlinkSync(path.join(folder, f));
    }
    fs.rmdirSync(folder);
  } catch { /* leave temp files if cleanup fails */ }
};

// --- public pipelines -------------------------------------------------------

/**
 * Encode the output of a host-side comp render into a GIF. Chooses the pipeline
 * from `render.mode`: PNG sequences go straight to gifski; ProRes movies pass
 * through ffmpeg first. Resolves with the GIF path.
 */
export const encodeRenderToGif = (
  render: RenderResult,
  opts: EncodeOptions,
  onProgress: (p: GifProgress) => void,
): Promise<string> => {
  const path = window.require('path');
  const bins = resolveBinaries();
  if (!bins.ok) {
    return Promise.reject(new Error(`Missing binaries:${!bins.ffmpegExists ? ' ffmpeg' : ''}${!bins.gifskiExists ? ' gifski' : ''}`.trim()));
  }

  const finish = () => {
    cleanupFolder(render.folder, opts.keepFrames);
    onProgress({ phase: 'encode', percent: 100, message: 'Done.' });
    return opts.output;
  };
  const fail = (err: any) => {
    cleanupFolder(render.folder, opts.keepFrames);
    throw err instanceof Error ? err : new Error(String(err));
  };

  if (render.mode === 'png') {
    // AE already produced the frames; gifski owns the entire bar.
    const prefix = path.basename(render.base);
    const frames = collectSequence(render.folder, prefix);
    onProgress({ phase: 'encode', percent: 0, message: 'Encoding GIF…' });
    return gifskiEncode(bins.gifski, frames, opts, 0, 1, onProgress).then(finish).catch(fail);
  }

  // ProRes: extract frames with ffmpeg, then encode.
  const framePattern = path.join(render.folder, 'frame_%05d.png');
  onProgress({ phase: 'extract', percent: 0, message: 'Extracting frames…' });
  return ffmpegExtract(bins.ffmpeg, `${render.base}.mov`, framePattern, opts.width, opts.fps, EXTRACT_WEIGHT, onProgress)
    .then(() => {
      const frames = collectSequence(render.folder, 'frame');
      return gifskiEncode(bins.gifski, frames, opts, EXTRACT_WEIGHT, 1 - EXTRACT_WEIGHT, onProgress);
    })
    .then(finish)
    .catch(fail);
};

/**
 * Convert an arbitrary existing video (mov/mp4/avi/gif) to a GIF — GIPHER's
 * "Convert" feature. Always ffmpeg → gifski.
 */
export const convertVideoToGif = (
  input: string,
  opts: EncodeOptions & { tempDir: string },
  onProgress: (p: GifProgress) => void,
): Promise<string> => {
  const fs = window.require('fs');
  const path = window.require('path');
  const bins = resolveBinaries();
  if (!bins.ok) {
    return Promise.reject(new Error(`Missing binaries:${!bins.ffmpegExists ? ' ffmpeg' : ''}${!bins.gifskiExists ? ' gifski' : ''}`.trim()));
  }
  if (!fs.existsSync(opts.tempDir)) fs.mkdirSync(opts.tempDir, { recursive: true });

  const framePattern = path.join(opts.tempDir, 'frame_%05d.png');
  onProgress({ phase: 'extract', percent: 0, message: 'Extracting frames…' });
  return ffmpegExtract(bins.ffmpeg, input, framePattern, opts.width, opts.fps, EXTRACT_WEIGHT, onProgress)
    .then(() => {
      const frames = collectSequence(opts.tempDir, 'frame');
      return gifskiEncode(bins.gifski, frames, opts, EXTRACT_WEIGHT, 1 - EXTRACT_WEIGHT, onProgress);
    })
    .then(() => {
      cleanupFolder(opts.tempDir, opts.keepFrames);
      onProgress({ phase: 'encode', percent: 100, message: 'Done.' });
      return opts.output;
    })
    .catch((err: any) => {
      cleanupFolder(opts.tempDir, opts.keepFrames);
      throw err instanceof Error ? err : new Error(String(err));
    });
};
