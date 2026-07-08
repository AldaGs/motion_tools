// MTAG Switch — Stage 2 POC panel.
// Detects host (AI vs AE). In AI, "Send selection" exports the first selected
// path and pushes an artwork.send envelope. In AE, incoming artwork.send is
// piped straight into ExtendScript, which creates a shape layer at comp center.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { getOrCreatePeer, type Peer, type PeerStatus } from './bridge/peer';
import { subscribeLog, type LogEntry } from './bridge/log';
import type { ArtworkPayload, HelloPayload, AnyItem } from './bridge/schema';
import { detectHost, evalJsx, getSwitchScriptPath, hostToPeerKind, jsxStr, loadSwitchScript, type HostApp } from './bridge/host';
import { info as logInfo, err as logErr } from './bridge/log';
import { copyText } from './utils/clipboard';
import SendIcon from '@mui/icons-material/Send';
import LayersIcon from '@mui/icons-material/Layers';
import LayersClearIcon from '@mui/icons-material/LayersClear';
import FilterCenterFocusIcon from '@mui/icons-material/FilterCenterFocus';
import CropFreeIcon from '@mui/icons-material/CropFree';
import BugReportIcon from '@mui/icons-material/BugReport';
import PaletteIcon from '@mui/icons-material/Palette';
import FormatColorFillIcon from '@mui/icons-material/FormatColorFill';
import BorderColorIcon from '@mui/icons-material/BorderColor';
import { IconButton, Tooltip } from '@mui/material';
import { saveAiColorClip, loadSwitchSettings, saveSwitchSettings } from './utils/storage';
import { getHostTheme } from './utils/hostTheme';

const CLIENT_VERSION = '0.2.0-poc';
const PORT_RANGE: [number, number] = [47821, 47830];

type Transport = 'bridgetalk' | 'websocket';

// Import result string shape from mtagSwitchAeImport (parsed from the beam
// result file, which stores the raw {ok,data|error} JSON string).
interface ImportResult {
  ok: boolean;
  data?: { layerIndex: number; layerName: string; fills: number; strokes: number; warnings: string[] };
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// True if any node (recursing into groups) is an image — used to decide whether
// the send needs an AE image folder.
function containsImage(nodes: AnyItem[]): boolean {
  return nodes.some((n) => n.kind === 'image' || (n.kind === 'group' && containsImage(n.children)));
}

function summarizeItem(item: AnyItem): string {
  if (item.kind === 'group') {
    return `[Group] ${item.name} · ${item.children.length} item${item.children.length === 1 ? '' : 's'}${item.clip ? ' · clipped' : ''}`;
  }
  if (item.kind === 'image') {
    return `[Image] ${item.name}${item.linked ? '' : ' (embedded)'}`;
  }
  if (item.kind === 'text') {
    return `[Text] ${item.name} ("${item.text.slice(0, 10)}${item.text.length > 10 ? '...' : ''}") · ${item.font} ${item.fontSize}px`;
  }
  const nSub = item.geometry.subpaths.length;
  const fills = item.appearance.fills;
  const strokes = item.appearance.strokes;
  const grad = [...fills, ...strokes.map((s) => s.paint)].some((p) => p.kind === 'gradient');
  const parts = [`[Path] ${item.name}`, `${nSub} subpath${nSub === 1 ? '' : 's'}`];
  if (fills.length) parts.push(`${fills.length}f`);
  if (strokes.length) parts.push(`${strokes.length}s`);
  if (grad) parts.push('grad');
  if (item.blendMode && item.blendMode !== 'normal') parts.push(item.blendMode);
  if (item.opacity < 1) parts.push(`${Math.round(item.opacity * 100)}%`);
  return parts.join(' · ');
}

const statusColor: Record<PeerStatus, string> = {
  idle: '#666',
  connecting: '#c99a2e',
  ready: '#3fb950',
  disconnected: '#c44',
};

export default function MtagSwitch() {
  const peerRef = useRef<Peer | null>(null);
  const host = useMemo<HostApp>(() => detectHost(), []);
  const theme = useMemo(() => getHostTheme(), []);
  const [status, setStatus] = useState<PeerStatus>('idle');
  const [remote, setRemote] = useState<HelloPayload | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [wire, setWire] = useState<{ dir: 'in' | 'out'; type: string; summary: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);
  // Default to BridgeTalk: no second panel required, no port/handshake pain.
  const [transport, setTransport] = useState<Transport>('bridgetalk');
  // Restore the last-used toggle selection from disk so reopening the panel
  // keeps the user's choice instead of reverting to defaults.
  const savedSwitch = useMemo(() => loadSwitchSettings(), []);
  const [grouped, setGrouped] = useState(savedSwitch.grouped);
  const [centerAnchor, setCenterAnchor] = useState(savedSwitch.centerAnchor);
  const [lastPickInfo, setLastPickInfo] = useState<string | null>(null);
  // Per-project image export/import folder (AE side only). Stored inside the
  // .aep via the project's XMP packet, so it travels with the project file.
  const [exportDir, setExportDir] = useState<string | null>(null);
  const [exportDirBusy, setExportDirBusy] = useState(false);
  const [exportDirNotice, setExportDirNotice] = useState<string | null>(null);
  // Send-time prompt (AI/PS) when the AE project has no image folder set yet.
  const [folderPrompt, setFolderPrompt] = useState<{ projectSaved: boolean; aepDir: string | null } | null>(null);
  const folderPromptResolve = useRef<((chosen: boolean) => void) | null>(null);

  const pickColors = async (mode: 'fill' | 'stroke' | 'both') => {
    setBusy(true);
    setLastPickInfo(null);
    try {
      const hexes = await evalJsx<string[]>(`mtagAiExtractColors(${JSON.stringify(mode)})`);
      if (!hexes || hexes.length === 0) {
        setLastPickInfo('No colors found.');
        return;
      }
      // Prefix with '#' for the Color panel.
      const withHash = hexes.map(h => '#' + h.replace(/^#/, ''));
      saveAiColorClip(withHash);
      setLastPickInfo(`${withHash.length} color${withHash.length === 1 ? '' : 's'} saved to palette clipboard`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastPickInfo(`Error: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  // Persist the toggle selection whenever it changes so the next panel open
  // restores it.
  useEffect(() => {
    saveSwitchSettings({ grouped, centerAnchor });
  }, [grouped, centerAnchor]);

  useEffect(() => {
    let cancelled = false;
    loadSwitchScript()
      .then(() => { if (!cancelled) logInfo(`mtagSwitch.jsx loaded (host=${host})`); })
      .catch((e) => logErr(`load mtagSwitch.jsx failed: ${e.message}`));
    return () => { cancelled = true; };
  }, [host]);

  // Load the per-project image folder from the active AE project's XMP packet.
  // Waits for the companion script to load first (evalJsx needs it defined).
  useEffect(() => {
    if (host !== 'ae') return;
    let cancelled = false;
    loadSwitchScript()
      .then(() => evalJsx<Record<string, unknown>>('mtagGetProjectSettings()'))
      .then((s) => {
        if (!cancelled) setExportDir(typeof s.imageExportDir === 'string' ? s.imageExportDir : null);
      })
      .catch(() => { /* no project open, or XMP unavailable — leave unset */ });
    return () => { cancelled = true; };
  }, [host]);

  const chooseExportDir = async () => {
    setExportDirBusy(true);
    setExportDirNotice(null);
    try {
      const res = await evalJsx<{ path?: string; cancelled?: boolean }>(`mtagPickFolder(${jsxStr(exportDir || '')})`);
      if (res.cancelled || !res.path) return;
      await evalJsx(`mtagSetProjectSetting(${jsxStr('imageExportDir')}, ${jsxStr(res.path)})`);
      setExportDir(res.path);
      logInfo(`project image folder → ${res.path} (save the project to persist)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logErr(`set image folder failed: ${msg}`);
    } finally {
      setExportDirBusy(false);
    }
  };

  // Set the image folder to an "MTAG_Images" folder next to the saved .aep.
  // If the project has never been saved it has no location — prompt to save.
  const useFolderNextToFile = async () => {
    setExportDirBusy(true);
    setExportDirNotice(null);
    try {
      const res = await evalJsx<{ dir: string }>('mtagGetProjectDir()');
      const target = `${res.dir}/MTAG_Images`;
      await evalJsx(`mtagSetProjectSetting(${jsxStr('imageExportDir')}, ${jsxStr(target)})`);
      setExportDir(target);
      logInfo(`project image folder → ${target}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'unsaved') {
        setExportDirNotice('Save the project first (File ▸ Save), then try again.');
      } else {
        logErr(`next-to-file failed: ${msg}`);
        setExportDirNotice(msg);
      }
    } finally {
      setExportDirBusy(false);
    }
  };

  // Log subscription is independent of transport so the diagnostic panel works
  // in BridgeTalk mode too (where no WebSocket peer exists).
  useEffect(() => subscribeLog(setLogs), []);

  useEffect(() => {
    // Only the WebSocket transport needs a live peer. In BridgeTalk mode we
    // skip it entirely — no port binding, no reconnect loop.
    if (transport !== 'websocket') {
      setTimeout(() => {
        setStatus('idle');
        setRemote(null);
      }, 0);
      peerRef.current = null;
      return;
    }
    const peer = getOrCreatePeer({
      kind: hostToPeerKind(host),
      portRange: PORT_RANGE,
      clientVersion: CLIENT_VERSION,
      capabilities: (host === 'ai' || host === 'ps') ? ['artwork.export'] : host === 'ae' ? ['artwork.import'] : [],
    });
    peerRef.current = peer;

    const record = (dir: 'in' | 'out', type: string, summary: string) => {
      setWire((prev) => {
        const next = [...prev, { dir, type, summary }];
        return next.length > 100 ? next.slice(next.length - 100) : next;
      });
    };

    const offStatus = peer.onStatus(setStatus);
    const offInfo = peer.onPeerInfo(setRemote);

    const offArt = peer.on<ArtworkPayload>('artwork.send', async (env) => {
      const firstItem = env.payload?.items?.[0];
      const summary = firstItem ? `${env.payload.items.length} item(s): ${summarizeItem(firstItem)}` : '(empty)';
      record('in', 'artwork.send', summary);
      if (host !== 'ae') return;
      try {
        const json = JSON.stringify(env.payload).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const result = await evalJsx<{ layerIndex: number; layerName: string; fills: number; strokes: number; warnings: string[] }>(
          `mtagSwitchAeImport("${json}")`
        );
        logInfo(`imported → layer #${result.layerIndex} "${result.layerName}" (${result.fills} fill/${result.strokes} stroke)`);
        (result.warnings || []).forEach((w) => logErr(`downgrade: ${w}`));
      } catch (e) {
        logErr(`import failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    const offHello = peer.on<HelloPayload>('hello', (env) =>
      record('in', 'hello', `${env.payload.kind} v${env.payload.clientVersion}`)
    );

    // Note: we intentionally do NOT destroy the singleton on effect cleanup.
    // The peer outlives React re-mounts; only the listeners get unsubscribed.
    return () => {
      offStatus(); offInfo(); offArt(); offHello();
      peerRef.current = null;
    };
  }, [host, transport]);

  const recordOut = (payload: ArtworkPayload) => {
    const firstItem = payload.items?.[0];
    const summary = firstItem ? `${payload.items.length} item(s): ${summarizeItem(firstItem)}` : '(empty)';
    setWire((prev) => [...prev, {
      dir: 'out' as const, type: 'artwork.send', summary,
    }].slice(-100));
  };

  // WebSocket path: requires a live peer on the other side.
  const sendViaWebSocket = async (payload: ArtworkPayload) => {
    const peer = peerRef.current;
    if (!peer || status !== 'ready') throw new Error(`peer not ready (status=${status})`);
    await peer.send('artwork.send', payload);
    recordOut(payload);
    setLastResult(`sent ${payload.items.length} item(s) (websocket)`);
  };

  // Poll the shared BridgeTalk result file, unwrapping the {ok,data} envelope
  // the receiver wrote. Returns the data, or null on error/timeout.
  const pollBeamResult = async <T,>(attempts = 32, interval = 250): Promise<T | null> => {
    for (let i = 0; i < attempts; i++) {
      await sleep(interval);
      const poll = await evalJsx<{ pending: boolean; result?: string }>('mtagSwitchReadBeamResult()');
      if (poll.pending || !poll.result) continue;
      try {
        const parsed = JSON.parse(poll.result);
        if (parsed && parsed.ok === false) { logErr(`AE: ${parsed.error}`); return null; }
        return parsed.data as T;
      } catch {
        return null;
      }
    }
    return null;
  };

  // Persist a chosen folder into the AE project (over BridgeTalk).
  const applyAeFolder = async (dir: string) => {
    const scriptPath = getSwitchScriptPath();
    await evalJsx(`mtagSwitchSetAeImageDir(${jsxStr(scriptPath)}, ${jsxStr(dir)})`);
    await pollBeamResult();
    logInfo(`AE image folder set → ${dir}`);
  };

  const finishFolderPrompt = (chosen: boolean) => {
    setFolderPrompt(null);
    const r = folderPromptResolve.current;
    folderPromptResolve.current = null;
    if (r) r(chosen);
  };

  // Called before beaming a payload that contains images. Asks AE whether it
  // already has an image folder; if not, prompts the user (Choose / Next-to-
  // AEP) and writes the choice back. Returns false only if the user cancels.
  const ensureImageFolder = async (): Promise<boolean> => {
    const scriptPath = getSwitchScriptPath();
    try {
      await evalJsx(`mtagSwitchQueryAeImageDir(${jsxStr(scriptPath)})`);
    } catch (e) {
      logErr(`couldn't reach AE to check image folder: ${e instanceof Error ? e.message : String(e)} — proceeding`);
      return true; // AE auto-resolves on import
    }
    const info = await pollBeamResult<{ imageDirSet: boolean; imageDir: string | null; projectSaved: boolean; aepDir: string | null }>();
    if (!info) {
      logErr('AE did not respond to folder check — proceeding (AE will auto-place images)');
      return true;
    }
    if (info.imageDirSet) {
      logInfo(`AE image folder: ${info.imageDir}`);
      return true;
    }
    // Unset → prompt and wait for the user's choice.
    return await new Promise<boolean>((resolve) => {
      folderPromptResolve.current = resolve;
      setFolderPrompt({ projectSaved: info.projectSaved, aepDir: info.aepDir });
    });
  };

  const promptChooseFolder = async () => {
    try {
      const start = folderPrompt?.aepDir || '';
      const res = await evalJsx<{ path?: string; cancelled?: boolean }>(`mtagPickFolder(${jsxStr(start)})`);
      if (res.cancelled || !res.path) return; // keep the prompt open
      await applyAeFolder(res.path);
      finishFolderPrompt(true);
    } catch (e) {
      logErr(`choose folder failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const promptNextToAep = async () => {
    if (!folderPrompt?.projectSaved || !folderPrompt.aepDir) return;
    try {
      await applyAeFolder(`${folderPrompt.aepDir}/MTAG_Images`);
      finishFolderPrompt(true);
    } catch (e) {
      logErr(`next-to-project failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // BridgeTalk path: hands the payload to the target app directly. No panel
  // needs to be open on the receiving side.
  const sendViaBridgeTalk = async (payload: ArtworkPayload) => {
    const scriptPath = getSwitchScriptPath();
    // AI and PS both send to AE; AE sends back to AI.
    const target = host === 'ae' ? 'ai' : 'ae';
    const json = JSON.stringify(payload);
    logInfo(`beam → ${target} (${json.length}b)`);
    const beam = await evalJsx<{ sent: boolean; target: string; targetRunning: boolean }>(
      `mtagSwitchBeam(${jsxStr(target)}, ${jsxStr(scriptPath)}, ${jsxStr(json)})`
    );
    recordOut(payload);
    logInfo(`beam sent to ${beam.target}${beam.targetRunning ? '' : ' (launching)'}`);

    // Poll for the receiver's result file (written by mtagSwitchReceiveBeamAe).
    let done = false;
    for (let attempt = 0; attempt < 24 && !done; attempt++) {
      await sleep(250);
      const poll = await evalJsx<{ pending: boolean; result?: string }>('mtagSwitchReadBeamResult()');
      if (poll.pending || !poll.result) continue;
      done = true;
      let parsed: ImportResult;
      try {
        parsed = JSON.parse(poll.result);
      } catch {
        setLastResult('beam done, but result unreadable');
        return;
      }
      if (parsed.ok && parsed.data) {
        const d = parsed.data;
        logInfo(`imported in ${target.toUpperCase()} → "${d.layerName}" (${d.fills}f/${d.strokes}s)`);
        (d.warnings || []).forEach((w) => logErr(`downgrade: ${w}`));
        setLastResult(`imported "${d.layerName}" in ${target.toUpperCase()}`);
      } else {
        setLastResult(`receiver error: ${parsed.error}`);
        logErr(`receiver error: ${parsed.error}`);
      }
    }
    if (!done) setLastResult('beam sent — no result yet (receiver slow or busy)');
  };

  const sendSelection = async () => {
    setBusy(true);
    setLastResult(null);
    try {
      const exportFn = host === 'ps' ? 'mtagSwitchPsExport' : 'mtagSwitchAiExport';
      const payload = await evalJsx<ArtworkPayload>(`${exportFn}(${grouped}, ${centerAnchor})`);
      if (payload.skipped && payload.skipped.length) {
        logErr(`skipped ${payload.skipped.length} unsupported item(s): ${payload.skipped.join(', ')}`);
      }
      if (transport === 'bridgetalk') {
        // Images need a destination folder in the AE project — resolve it (and
        // prompt if unset) before beaming.
        const hasImages = containsImage(payload.items);
        if (hasImages) {
          const ok = await ensureImageFolder();
          if (!ok) { setLastResult('send cancelled — no image folder chosen'); return; }
        }
        await sendViaBridgeTalk(payload);
      } else {
        await sendViaWebSocket(payload);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastResult(`error: ${msg}`);
      logErr(`send failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const copyAll = async () => {
    const header = `MTAG Switch log — host=${host} status=${status} peer=${remote ? `${remote.kind} v${remote.clientVersion}` : 'none'}\n`;
    const wireBlock = 'Wire log:\n' + (wire.length === 0 ? '(empty)' :
      wire.map((w) => `${w.dir === 'in' ? '<-' : '->'} ${w.type} · ${w.summary}`).join('\n'));
    const transportBlock = 'Transport log:\n' + (logs.length === 0 ? '(empty)' :
      logs.map((l) => `[${new Date(l.ts).toISOString().slice(11, 23)}] [${l.level}] ${l.msg}`).join('\n'));
    const text = `${header}\n${wireBlock}\n\n${transportBlock}\n`;
    const ok = await copyText(text);
    setCopyStatus(ok ? 'copied' : 'copy failed');
    setTimeout(() => setCopyStatus(null), 1500);
  };

  const statusText = useMemo(() => {
    if (status === 'ready' && remote) return `ready · peer=${remote.kind} v${remote.clientVersion}`;
    return status;
  }, [status, remote]);

  const hostLabel = host === 'ai' ? 'Illustrator' : host === 'ae' ? 'After Effects' : host === 'ps' ? 'Photoshop' : 'Unknown host';

  const [showLogs, setShowLogs] = useState(false);

  // Adobe-style flat buttons for the plain HTML controls (folder row, prompt,
  // diagnostics). `primary` fills with the host accent.
  const btn = (opts?: { primary?: boolean; disabled?: boolean }): CSSProperties => ({
    padding: '4px 10px', borderRadius: 3, fontSize: theme.fontSize - 1,
    fontFamily: theme.fontFamily, whiteSpace: 'nowrap',
    border: `1px solid ${opts?.primary ? theme.accent : theme.border}`,
    background: opts?.disabled ? theme.bgInset : opts?.primary ? theme.accent : theme.bgElevated,
    color: opts?.disabled ? theme.textDim : opts?.primary ? theme.accentText : theme.text,
    cursor: opts?.disabled ? 'default' : 'pointer',
    opacity: opts?.disabled ? 0.5 : 1,
  });

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      background: theme.bg, color: theme.text, fontFamily: theme.fontFamily,
      fontSize: theme.fontSize, padding: 6, gap: 5, boxSizing: 'border-box',
      overflowY: 'auto', overflowX: 'hidden'
    }}>
      {(host === 'ai' || host === 'ps') && (() => {
        const canSend = !busy && (transport === 'bridgetalk' || status === 'ready');
        const tooltipProps = { slotProps: { tooltip: { sx: {
          fontSize: 12, padding: '5px 9px', backgroundColor: theme.bgInset,
          color: theme.text, border: `1px solid ${theme.border}`, borderRadius: '3px',
        } } } };

        // Adobe-style square tool button. `active` = toggled/pressed (accent
        // icon on an inset ground); `primary` = filled accent (the Send action).
        const toolSx = (active: boolean, primary = false) => ({
          width: 28, height: 28, borderRadius: '3px',
          color: primary ? theme.accentText : active ? theme.accent : theme.textDim,
          background: primary ? theme.accent : active ? theme.bgInset : theme.bgElevated,
          border: `1px solid ${primary ? theme.accent : theme.border}`,
          transition: 'background .12s, color .12s',
          '&:hover': {
            background: primary ? theme.accent : theme.hover,
            color: primary ? theme.accentText : active ? theme.accent : theme.text,
          },
          '&.Mui-disabled': { color: theme.textDim, background: theme.bgElevated, opacity: 0.45 },
        });
        const colorSx = {
          width: 28, height: 28, borderRadius: '3px',
          color: busy ? theme.textDim : '#e0913f',
          background: theme.bgElevated, border: `1px solid ${theme.border}`,
          '&:hover': { background: theme.hover },
          '&.Mui-disabled': { color: theme.textDim, opacity: 0.45 },
        };

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {/* Row 1: Core switch tools & Diagnostics */}
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <Tooltip title="Send to After Effects" {...tooltipProps}>
                <span>
                  <IconButton onClick={sendSelection} disabled={!canSend} size="small" sx={toolSx(false, canSend)}>
                    <SendIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>

              <Tooltip title={grouped ? "Grouped in one layer" : "Each in a different layer"} {...tooltipProps}>
                <IconButton onClick={() => setGrouped(!grouped)} size="small" sx={toolSx(grouped)}>
                  {grouped ? <LayersIcon fontSize="small" /> : <LayersClearIcon fontSize="small" />}
                </IconButton>
              </Tooltip>

              <Tooltip title={centerAnchor ? "Center anchor point in layer" : "Default anchor point"} {...tooltipProps}>
                <IconButton onClick={() => setCenterAnchor(!centerAnchor)} size="small" sx={toolSx(centerAnchor)}>
                  {centerAnchor ? <FilterCenterFocusIcon fontSize="small" /> : <CropFreeIcon fontSize="small" />}
                </IconButton>
              </Tooltip>

              {/* Diagnostics aligned to right */}
              <Tooltip title="Toggle Diagnostics" {...tooltipProps}>
                <IconButton onClick={() => setShowLogs(!showLogs)} size="small" sx={{ ...toolSx(showLogs), marginLeft: 'auto' }}>
                  <BugReportIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </div>

            {/* Row 2: Color pickers (Illustrator only) */}
            {host === 'ai' && (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <Tooltip title="Send Fill Colors to Palette" {...tooltipProps}>
                <span>
                  <IconButton disabled={busy} onClick={() => pickColors('fill')} size="small" sx={colorSx}>
                    <FormatColorFillIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>

              <Tooltip title="Send Stroke Colors to Palette" {...tooltipProps}>
                <span>
                  <IconButton disabled={busy} onClick={() => pickColors('stroke')} size="small" sx={colorSx}>
                    <BorderColorIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>

              <Tooltip title="Send Both (Fill + Stroke) to Palette" {...tooltipProps}>
                <span>
                  <IconButton disabled={busy} onClick={() => pickColors('both')} size="small" sx={colorSx}>
                    <PaletteIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </div>
            )}
          </div>
        );
      })()}

      {lastPickInfo && (
        <div style={{ fontSize: theme.fontSize - 1, color: lastPickInfo.startsWith('Error') ? '#e8756b' : theme.textDim, padding: '2px 4px' }}>
          {lastPickInfo}
        </div>
      )}

      {folderPrompt && (
        <div style={{
          border: `1px solid ${theme.accent}`, borderRadius: 4, background: theme.bgElevated,
          padding: 8, display: 'flex', flexDirection: 'column', gap: 6, fontSize: theme.fontSize,
        }}>
          <div style={{ color: theme.text }}>
            The After Effects project has no image folder set. Where should imported images go?
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={promptChooseFolder} style={btn({ primary: true })}>Choose folder…</button>
            <button
              onClick={promptNextToAep}
              disabled={!folderPrompt.projectSaved}
              title={folderPrompt.projectSaved ? 'Use an MTAG_Images folder next to the .aep' : 'Save the AE project first'}
              style={btn({ disabled: !folderPrompt.projectSaved })}
            >Next to project</button>
            <button onClick={() => finishFolderPrompt(false)} style={{ ...btn(), marginLeft: 'auto' }}>Cancel</button>
          </div>
          {!folderPrompt.projectSaved && (
            <div style={{ color: '#e2c14a', fontSize: theme.fontSize - 1 }}>
              Save the AE project (File ▸ Save) to enable “Next to project”.
            </div>
          )}
        </div>
      )}

      {host === 'ae' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <div style={{
              flex: 1, padding: '7px 10px', border: `1px solid ${theme.border}`, borderRadius: 3,
              background: theme.bgInset, color: theme.textDim,
            }}>
              {transport === 'bridgetalk'
                ? 'Receives automatically — this panel can stay closed'
                : 'Receiver (WebSocket)'}
            </div>
            <Tooltip title="Toggle Diagnostics">
              <IconButton onClick={() => setShowLogs(!showLogs)} size="small" sx={{
                width: 28, height: 28, borderRadius: '3px',
                color: showLogs ? theme.accent : theme.textDim,
                background: showLogs ? theme.bgInset : theme.bgElevated,
                border: `1px solid ${theme.border}`,
                '&:hover': { background: theme.hover },
              }}>
                <BugReportIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </div>

          {/* Per-project image folder (stored in the .aep's XMP metadata). */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: theme.fontSize }}>
            <span style={{ color: theme.textDim, whiteSpace: 'nowrap' }}>Image folder:</span>
            <span
              title={exportDir || 'Not set — choose where imported images are stored for this project'}
              style={{
                flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                direction: 'rtl', textAlign: 'left',
                color: exportDir ? theme.text : theme.textDim, fontFamily: 'ui-monospace, monospace',
              }}
            >
              {exportDir || 'not set (per-project)'}
            </span>
            <button onClick={chooseExportDir} disabled={exportDirBusy} style={btn({ disabled: exportDirBusy })}>Choose…</button>
            <button
              onClick={useFolderNextToFile}
              disabled={exportDirBusy}
              title="Use an MTAG_Images folder next to the saved project file"
              style={btn({ disabled: exportDirBusy })}
            >Next to file</button>
          </div>

          {exportDirNotice && (
            <div style={{ fontSize: theme.fontSize - 1, color: '#e2c14a', padding: '0 2px' }}>
              {exportDirNotice}
            </div>
          )}
        </div>
      )}

      {host === 'unknown' && (
        <div style={{ padding: '8px 10px', border: '1px solid #c4574d', borderRadius: 3, color: '#e8756b', background: theme.bgInset }}>
          Not running in a CEP host.
        </div>
      )}

      {lastResult && <div style={{ color: theme.textDim, padding: '0 4px' }}>{lastResult}</div>}

      {showLogs && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            {transport === 'websocket' ? (
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor[status], boxShadow: `0 0 6px ${statusColor[status]}` }} />
            ) : (
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#3fb950', boxShadow: '0 0 6px #3fb950' }} />
            )}
            <strong style={{ fontSize: theme.fontSize + 1 }}>Diagnostics</strong>
            <span style={{ color: theme.textDim, fontSize: theme.fontSize - 1 }}>· {hostLabel}</span>
            <span style={{ color: theme.textDim, marginLeft: 'auto' }}>
              {transport === 'websocket' ? statusText : 'BridgeTalk'}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 4, fontSize: theme.fontSize }}>
            {(['bridgetalk', 'websocket'] as Transport[]).map((t) => (
              <button
                key={t}
                onClick={() => setTransport(t)}
                style={{
                  flex: 1, padding: '4px 6px', borderRadius: 3, cursor: 'pointer',
                  fontFamily: theme.fontFamily, fontSize: theme.fontSize,
                  border: `1px solid ${transport === t ? theme.accent : theme.border}`,
                  background: transport === t ? theme.bgInset : theme.bgElevated,
                  color: transport === t ? theme.accent : theme.textDim,
                }}
              >{t === 'bridgetalk' ? 'BridgeTalk' : 'WebSocket'}</button>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <div style={{ fontWeight: 600 }}>Wire log</div>
            <button onClick={copyAll} style={{ ...btn(), marginLeft: 'auto', padding: '2px 8px' }}>
              {copyStatus ?? 'Copy logs'}
            </button>
          </div>
          <div style={{
            flex: 1, minHeight: 60, overflow: 'auto', background: theme.bgInset,
            border: `1px solid ${theme.border}`, borderRadius: 3, padding: 6, fontFamily: 'ui-monospace, monospace',
          }}>
            {wire.length === 0 && <div style={{ color: theme.textDim }}>no messages yet</div>}
            {wire.map((w, i) => (
              <div key={i} style={{ color: w.dir === 'in' ? '#6cb6ff' : '#e0913f' }}>
                {w.dir === 'in' ? '← ' : '→ '}{w.type} · {w.summary}
              </div>
            ))}
          </div>

          <div style={{ fontWeight: 600 }}>Transport log</div>
          <div style={{
            height: 130, overflow: 'auto', background: theme.bgInset,
            border: `1px solid ${theme.border}`, borderRadius: 3, padding: 6, fontFamily: 'ui-monospace, monospace',
          }}>
            {logs.slice(-60).map((l, i) => (
              <div key={i} style={{
                color: l.level === 'error' ? '#e8756b' : l.level === 'warn' ? '#e0913f' : theme.textDim,
              }}>
                [{new Date(l.ts).toLocaleTimeString()}] {l.msg}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
