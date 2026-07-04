// MTAG Switch — Stage 2 POC panel.
// Detects host (AI vs AE). In AI, "Send selection" exports the first selected
// path and pushes an artwork.send envelope. In AE, incoming artwork.send is
// piped straight into ExtendScript, which creates a shape layer at comp center.
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { IconButton, Tooltip } from '@mui/material';

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

function summarizeItem(item: AnyItem): string {
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
  const [status, setStatus] = useState<PeerStatus>('idle');
  const [remote, setRemote] = useState<HelloPayload | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [wire, setWire] = useState<{ dir: 'in' | 'out'; type: string; summary: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);
  // Default to BridgeTalk: no second panel required, no port/handshake pain.
  const [transport, setTransport] = useState<Transport>('bridgetalk');
  const [grouped, setGrouped] = useState(true);
  const [centerAnchor, setCenterAnchor] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadSwitchScript()
      .then(() => { if (!cancelled) logInfo(`mtagSwitch.jsx loaded (host=${host})`); })
      .catch((e) => logErr(`load mtagSwitch.jsx failed: ${e.message}`));
    return () => { cancelled = true; };
  }, [host]);

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
      capabilities: host === 'ai' ? ['artwork.export'] : host === 'ae' ? ['artwork.import'] : [],
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

  // BridgeTalk path: hands the payload to the target app directly. No panel
  // needs to be open on the receiving side.
  const sendViaBridgeTalk = async (payload: ArtworkPayload) => {
    const scriptPath = getSwitchScriptPath();
    const target = host === 'ai' ? 'ae' : 'ai';
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
      const payload = await evalJsx<ArtworkPayload>(`mtagSwitchAiExport(${grouped}, ${centerAnchor})`);
      if (transport === 'bridgetalk') await sendViaBridgeTalk(payload);
      else await sendViaWebSocket(payload);
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

  const hostLabel = host === 'ai' ? 'Illustrator' : host === 'ae' ? 'After Effects' : 'Unknown host';

  const [showLogs, setShowLogs] = useState(false);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      background: '#1e1e1e', color: '#ddd', fontFamily: 'system-ui, sans-serif',
      fontSize: 12, padding: 4, gap: 4, boxSizing: 'border-box',
      overflowY: 'auto', overflowX: 'hidden'
    }}>
      {host === 'ai' && (() => {
        const canSend = !busy && (transport === 'bridgetalk' || status === 'ready');
        return (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Tooltip title="Send to After Effects">
              <span>
                <IconButton 
                  onClick={sendSelection} 
                  disabled={!canSend}
                  size="medium"
                  sx={{ 
                    color: canSend ? '#dfd' : '#555', 
                    background: canSend ? '#2a4a2a' : '#222', 
                    '&:hover': { background: canSend ? '#3b5b3b' : '#222' } 
                  }}
                >
                  <SendIcon fontSize="inherit" />
                </IconButton>
              </span>
            </Tooltip>

            <Tooltip title={grouped ? "Grouped in one layer" : "Each in a different layer"}>
              <IconButton onClick={() => setGrouped(!grouped)} sx={{ color: grouped ? '#4a90e2' : '#888' }}>
                {grouped ? <LayersIcon /> : <LayersClearIcon />}
              </IconButton>
            </Tooltip>

            <Tooltip title={centerAnchor ? "Center anchor point in layer" : "Default anchor point"}>
              <IconButton onClick={() => setCenterAnchor(!centerAnchor)} sx={{ color: centerAnchor ? '#4a90e2' : '#888' }}>
                {centerAnchor ? <FilterCenterFocusIcon /> : <CropFreeIcon />}
              </IconButton>
            </Tooltip>

            <Tooltip title="Toggle Diagnostics">
              <IconButton onClick={() => setShowLogs(!showLogs)} sx={{ color: showLogs ? '#fff' : '#888', marginLeft: 'auto' }}>
                <BugReportIcon />
              </IconButton>
            </Tooltip>
          </div>
        );
      })()}

      {host === 'ae' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{
            flex: 1, padding: '8px 10px', border: '1px dashed #444', borderRadius: 3,
            background: '#181818', opacity: 0.85,
          }}>
            {transport === 'bridgetalk'
              ? 'Receiver (BridgeTalk)'
              : 'Receiver (WebSocket)'}
          </div>
          <Tooltip title="Toggle Diagnostics">
            <IconButton onClick={() => setShowLogs(!showLogs)} sx={{ color: showLogs ? '#fff' : '#888' }}>
              <BugReportIcon />
            </IconButton>
          </Tooltip>
        </div>
      )}

      {host === 'unknown' && (
        <div style={{ padding: '8px 10px', border: '1px solid #c44', borderRadius: 3, color: '#f99' }}>
          Not running in a CEP host.
        </div>
      )}
      
      {lastResult && <div style={{ opacity: 0.7, padding: '0 4px' }}>{lastResult}</div>}

      {showLogs && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            {transport === 'websocket' ? (
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor[status], boxShadow: `0 0 6px ${statusColor[status]}` }} />
            ) : (
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#3fb950', boxShadow: '0 0 6px #3fb950' }} />
            )}
            <strong style={{ fontSize: 13 }}>Diagnostics</strong>
            <span style={{ opacity: 0.6, fontSize: 11 }}>· {hostLabel}</span>
            <span style={{ opacity: 0.7, marginLeft: 'auto' }}>
              {transport === 'websocket' ? statusText : 'BridgeTalk'}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 4, fontSize: 11 }}>
            {(['bridgetalk', 'websocket'] as Transport[]).map((t) => (
              <button
                key={t}
                onClick={() => setTransport(t)}
                style={{
                  flex: 1, padding: '4px 6px', borderRadius: 3, cursor: 'pointer',
                  border: `1px solid ${transport === t ? '#4a7' : '#444'}`,
                  background: transport === t ? '#213' : '#222',
                  color: transport === t ? '#cfd' : '#999',
                }}
              >{t === 'bridgetalk' ? 'BridgeTalk' : 'WebSocket'}</button>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <div style={{ fontWeight: 600 }}>Wire log</div>
            <button
              onClick={copyAll}
              style={{
                marginLeft: 'auto', padding: '2px 8px', fontSize: 11,
                border: '1px solid #444', background: '#2a2a2a', color: '#ccc',
                borderRadius: 3, cursor: 'pointer',
              }}
            >{copyStatus ?? 'Copy logs'}</button>
          </div>
          <div style={{
            flex: 1, minHeight: 60, overflow: 'auto', background: '#141414',
            border: '1px solid #333', borderRadius: 3, padding: 6, fontFamily: 'ui-monospace, monospace',
          }}>
            {wire.length === 0 && <div style={{ opacity: 0.5 }}>no messages yet</div>}
            {wire.map((w, i) => (
              <div key={i} style={{ color: w.dir === 'in' ? '#7cf' : '#fc7' }}>
                {w.dir === 'in' ? '← ' : '→ '}{w.type} · {w.summary}
              </div>
            ))}
          </div>

          <div style={{ fontWeight: 600 }}>Transport log</div>
          <div style={{
            height: 130, overflow: 'auto', background: '#141414',
            border: '1px solid #333', borderRadius: 3, padding: 6, fontFamily: 'ui-monospace, monospace',
          }}>
            {logs.slice(-60).map((l, i) => (
              <div key={i} style={{
                color: l.level === 'error' ? '#f77' : l.level === 'warn' ? '#fc7' : '#9c9',
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
