// Symmetric peer over a single WebSocket connection. Both sides use the same
// API — whichever process wins the port race becomes the binder, the other
// becomes the connector. That distinction is internal and never surfaced.
//
// CEP note: this file runs inside a browser-like CEF context that also exposes
// a Node.js `require` via `window.cep_node`. We use Node's `ws` package on the
// binder side (to listen()) and the built-in browser WebSocket on the
// connector side (to keep bundling simple and avoid a second `ws` client).

import {
  type AnyEnvelope,
  type Envelope,
  type HelloPayload,
  type MessageType,
  type PeerKind,
  SCHEMA_VERSION,
} from './schema';
import { err, info, warn } from './log';

export type PeerStatus =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'disconnected';

export interface PeerOptions {
  kind: PeerKind;
  portRange: [number, number];
  clientVersion: string;
  capabilities?: string[];
}

export interface Peer {
  status: PeerStatus;
  send<T>(type: MessageType, payload: T): Promise<void>;
  on<T = unknown>(type: MessageType, fn: (msg: Envelope<T>) => void): () => void;
  onStatus(fn: (s: PeerStatus) => void): () => void;
  onPeerInfo(fn: (info: HelloPayload | null) => void): () => void;
  destroy(): void;
}

interface Sink {
  send(text: string): void;
  close(): void;
}

type ListenerMap = Map<MessageType, Set<(msg: AnyEnvelope) => void>>;

function newId(): string {
  // Cheap RFC-4122-ish v4. Not cryptographic — just unique per message.
  const rand = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${rand()}${rand()}-${rand()}-4${rand().slice(1)}-${rand()}-${rand()}${rand()}${rand()}`;
}

function cepRequire(mod: string): any {
  const w = window as any;
  if (w.cep_node && typeof w.cep_node.require === 'function') {
    return w.cep_node.require(mod);
  }
  if (typeof (w as any).require === 'function') {
    return (w as any).require(mod);
  }
  throw new Error(`cep_node.require unavailable — cannot load "${mod}". Are you running outside CEP?`);
}

// Module-level singleton so React effect churn (StrictMode, re-renders,
// hot reload) cannot create a second peer that fights the first over the
// same loopback port.
let _singleton: Peer | null = null;
let _singletonKey: string | null = null;

export function getOrCreatePeer(opts: PeerOptions): Peer {
  const key = `${opts.kind}:${opts.portRange[0]}-${opts.portRange[1]}`;
  if (_singleton && _singletonKey === key) return _singleton;
  if (_singleton) {
    // Options changed — tear down the old one.
    _singleton.destroy();
    _singleton = null;
  }
  _singleton = createPeer(opts);
  _singletonKey = key;
  return _singleton;
}

export function createPeer(opts: PeerOptions): Peer {
  const listeners: ListenerMap = new Map();
  const statusListeners = new Set<(s: PeerStatus) => void>();
  const peerInfoListeners = new Set<(i: HelloPayload | null) => void>();

  let status: PeerStatus = 'idle';
  let sink: Sink | null = null;
  let remoteHello: HelloPayload | null = null;
  let destroyed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (s: PeerStatus) => {
    if (status === s) return;
    status = s;
    statusListeners.forEach((fn) => fn(s));
  };

  const setPeerInfo = (i: HelloPayload | null) => {
    remoteHello = i;
    peerInfoListeners.forEach((fn) => fn(i));
  };

  const dispatch = (raw: string) => {
    info(`rx (${raw.length}b): ${raw.slice(0, 120)}${raw.length > 120 ? '…' : ''}`);
    let env: AnyEnvelope;
    try {
      env = JSON.parse(raw) as AnyEnvelope;
    } catch (e: any) {
      warn(`dropping malformed message: ${e.message}`);
      return;
    }
    if (env.v !== SCHEMA_VERSION) {
      err(`schema mismatch: peer=${env.v} local=${SCHEMA_VERSION}`);
      return;
    }
    info(`dispatch type=${env.type}`);
    if (env.type === 'hello') {
      const hello = env.payload as HelloPayload;
      if (!sink) {
        warn('hello received on dead sink — ignoring (post-close queued message)');
        return;
      }
      setPeerInfo(hello);
      info(`handshake ok — peer=${hello.kind} v=${hello.clientVersion}`);
      disarmHelloTimeout();
      setStatus('ready');
    }
    if (env.type === 'ping') {
      writeRaw({
        v: SCHEMA_VERSION, id: newId(), ts: Date.now(),
        from: opts.kind, type: 'pong', payload: { refId: env.id },
      });
    }
    const set = listeners.get(env.type);
    if (set) set.forEach((fn) => fn(env));
  };

  const writeRaw = (env: AnyEnvelope) => {
    if (!sink) {
      warn(`writeRaw: no sink for type=${env.type} — dropping`);
      return;
    }
    const s = JSON.stringify(env);
    info(`tx type=${env.type} (${s.length}b)`);
    sink.send(s);
  };

  const sendHello = () => {
    const hello: HelloPayload = {
      kind: opts.kind,
      clientVersion: opts.clientVersion,
      capabilities: opts.capabilities ?? [],
    };
    writeRaw({
      v: SCHEMA_VERSION, id: newId(), ts: Date.now(),
      from: opts.kind, type: 'hello', payload: hello,
    });
  };

  const onOpen = () => {
    info('socket open — sending hello');
    sendHello();
  };

  const onClose = (reason: string) => {
    warn(`socket closed: ${reason}`);
    sink = null;
    setPeerInfo(null);
    setStatus('disconnected');
    if (!destroyed) scheduleReconnect();
  };

  const scheduleReconnect = () => {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!destroyed) tryConnectOrBind();
    }, 1500);
  };

  // Handshake watchdog: if we open a socket but no valid hello arrives within
  // this many ms, we assume we're talking to a ghost/foreign server and drop it.
  const HELLO_TIMEOUT_MS = 6000;
  let helloTimer: ReturnType<typeof setTimeout> | null = null;
  const armHelloTimeout = () => {
    if (helloTimer) clearTimeout(helloTimer);
    helloTimer = setTimeout(() => {
      if (status !== 'ready') {
        warn(`no hello within ${HELLO_TIMEOUT_MS}ms — closing suspect peer`);
        if (sink) sink.close();
      }
    }, HELLO_TIMEOUT_MS);
  };
  const disarmHelloTimeout = () => {
    if (helloTimer) { clearTimeout(helloTimer); helloTimer = null; }
  };

  // --- binder path (Node ws) — async, resolves only after 'listening' or 'error' ---
  const tryBind = (port: number): Promise<Sink | 'in-use' | 'failed'> => new Promise((resolve) => {
    let WS: any;
    try {
      WS = cepRequire('ws');
    } catch (e: any) {
      err(`cannot require('ws'): ${e.message}`);
      resolve('failed');
      return;
    }
    let server: any;
    try {
      // perMessageDeflate disabled: Chromium's WebSocket client (used by the
      // connector side inside CEF) occasionally hangs / drops idle connections
      // when the server negotiates deflate. Loopback traffic doesn't benefit
      // from compression anyway.
      server = new WS.WebSocketServer({ host: '127.0.0.1', port, perMessageDeflate: false });
    } catch (e: any) {
      warn(`bind ${port} failed synchronously: ${e.message}`);
      resolve('failed');
      return;
    }
    let settled = false;
    let activeSocket: any = null;

    const boundSink: Sink = {
      send(text) {
        if (!activeSocket) { warn('bound send: no activeSocket'); return; }
        if (activeSocket.readyState !== 1) {
          warn(`bound send: socket state=${activeSocket.readyState}, dropping`);
          return;
        }
        activeSocket.send(text, (e: any) => {
          if (e) err(`bound send callback err: ${e.message}`);
        });
      },
      close() {
        try { server.close(); } catch { /* noop */ }
        if (activeSocket) { try { activeSocket.close(); } catch { /* noop */ } }
      },
    };
    // Publish sink synchronously so any send that happens inside the
    // 'connection'/'listening' handlers below finds it set. If bind fails
    // (EADDRINUSE / other error) the error branch clears it before resolving.
    sink = boundSink;

    server.on('listening', () => {
      if (settled) return;
      settled = true;
      info(`bound port ${port} (waiting for peer)`);
      setStatus('connecting');
      resolve(boundSink);
    });
    server.on('error', (e: any) => {
      if (settled) {
        err(`server error post-bind: ${e.message}`);
        return;
      }
      settled = true;
      // Clear the optimistically-published sink so nothing tries to send
      // through a server that never listened.
      if (sink === boundSink) sink = null;
      if (e.code === 'EADDRINUSE') {
        warn(`port ${port} in use — falling through to connector`);
        try { server.close(); } catch { /* noop */ }
        resolve('in-use');
      } else {
        err(`bind ${port} error: ${e.message}`);
        try { server.close(); } catch { /* noop */ }
        resolve('failed');
      }
    });
    let connCount = 0;
    server.on('connection', (ws: any) => {
      connCount++;
      info(`peer connected on ${port} (conn #${connCount})`);
      if (activeSocket) {
        warn(`replacing existing activeSocket (state=${activeSocket.readyState})`);
        try { activeSocket.terminate(); } catch { /* noop */ }
      }
      activeSocket = ws;
      // WS-level keep-alive: browsers auto-reply to control-frame pings, so
      // the server pinging is enough to keep NAT / OS-level idle timers happy.
      let alive = true;
      ws.on('pong', () => { alive = true; });
      const keepalive = setInterval(() => {
        if (!alive) {
          warn('keep-alive: no pong — terminating socket');
          try { ws.terminate(); } catch { /* noop */ }
          clearInterval(keepalive);
          return;
        }
        alive = false;
        try { ws.ping(); } catch { /* noop */ }
      }, 15000);
      ws.on('message', (data: any) => dispatch(data.toString('utf8')));
      ws.on('close', (code: number, reason: any) => {
        clearInterval(keepalive);
        const r = reason && reason.toString ? reason.toString() : String(reason);
        onClose(`peer disconnected (code=${code} reason=${r || 'none'})`);
      });
      ws.on('error', (e: any) => err(`peer socket error: ${e.message}`));
      armHelloTimeout();
      onOpen();
    });
  });

  // --- connector path (browser WebSocket) ---
  const tryConnect = (port: number): Promise<Sink | 'refused'> => new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch (e: any) {
      warn(`connect ${port} failed: ${e.message}`);
      resolve('refused');
      return;
    }
    let settled = false;
    const connectorSink: Sink = {
      send(text) {
        if (ws.readyState !== 1) {
          warn(`connector send: socket state=${ws.readyState}, dropping`);
          return;
        }
        ws.send(text);
      },
      close() { try { ws.close(); } catch { /* noop */ } },
    };
    // Publish sink synchronously. If the connect never opens, onclose below
    // clears it before resolving as 'refused'.
    sink = connectorSink;
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      info(`connected to port ${port}`);
      armHelloTimeout();
      onOpen();
      resolve(connectorSink);
    };
    ws.onmessage = (ev) => dispatch(String(ev.data));
    ws.onerror = () => { /* onclose will fire */ };
    ws.onclose = (ev: CloseEvent) => {
      if (!settled) {
        settled = true;
        if (sink === connectorSink) sink = null;
        resolve('refused');
        return;
      }
      onClose(`connector closed (port ${port} code=${ev.code} reason=${ev.reason || 'none'} wasClean=${ev.wasClean})`);
    };
  });

  const tryConnectOrBind = async () => {
    if (destroyed) return;
    disarmHelloTimeout();
    setStatus('connecting');

    const [lo, hi] = opts.portRange;
    // Bind-first strategy. We attempt to bind each port in order. If a bind
    // succeeds → we're the host and wait for a peer. If EADDRINUSE → another
    // panel already bound that port, so we connect to it. Any other error →
    // try the next port.
    for (let p = lo; p <= hi; p++) {
      const r = await tryBind(p);
      if (destroyed) return;
      if (r === 'failed') continue;
      if (typeof r !== 'string') {
        // bound successfully; sink is live via the connection handler
        sink = r;
        return;
      }
      // in-use → attempt to connect as client
      const c = await tryConnect(p);
      if (destroyed) return;
      if (c === 'refused') {
        warn(`port ${p} refused after EADDRINUSE — race or ghost, trying next`);
        continue;
      }
      sink = c;
      return;
    }
    err('exhausted port range without binding or connecting');
    setStatus('disconnected');
    scheduleReconnect();
  };

  const peer: Peer = {
    get status() { return status; },
    async send<T>(type: MessageType, payload: T) {
      if (!sink || status !== 'ready') throw new Error(`peer not ready (status=${status})`);
      const env: Envelope<T> = {
        v: SCHEMA_VERSION, id: newId(), ts: Date.now(),
        from: opts.kind, type, payload,
      };
      writeRaw(env as AnyEnvelope);
    },
    on<T = unknown>(type: MessageType, fn: (msg: Envelope<T>) => void) {
      let set = listeners.get(type);
      if (!set) { set = new Set(); listeners.set(type, set); }
      set.add(fn as (msg: AnyEnvelope) => void);
      return () => { set!.delete(fn as (msg: AnyEnvelope) => void); };
    },
    onStatus(fn) { statusListeners.add(fn); fn(status); return () => { statusListeners.delete(fn); }; },
    onPeerInfo(fn) { peerInfoListeners.add(fn); fn(remoteHello); return () => { peerInfoListeners.delete(fn); }; },
    destroy() {
      destroyed = true;
      disarmHelloTimeout();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (sink) sink.close();
      sink = null;
      setStatus('idle');
    },
  };

  tryConnectOrBind();
  return peer;
}
