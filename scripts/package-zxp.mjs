// Stage the runtime files and sign them into a distributable .zxp.
//
// Run via `npm run package` (which builds first). Optionally bump the manifest
// version in the same step:  `npm run package -- --version 1.0.2`
//
// Config (paths + cert password) is read from a gitignored `zxp.local.json`
// next to package.json, with env vars overriding. See zxp.local.example.json.
// Nothing secret lives in the repo.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGING = path.join(ROOT, '.zxp-staging');
const MANIFEST = path.join(ROOT, 'CSXS', 'manifest.xml');

// Folders/files that the installed extension actually loads at runtime. The
// manifest points at ./dist/index.html + ./jsx/hostscript.jsx, and the panels
// resolve bin/ and templates/ from SystemPath.EXTENSION. Everything else in the
// repo (src, node_modules, configs, audits) is build-time only.
const RUNTIME = ['CSXS', 'dist', 'jsx', 'bin', 'templates'];

// ---- config -----------------------------------------------------------------
function loadConfig() {
  const file = path.join(ROOT, 'zxp.local.json');
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { fail(`Could not parse zxp.local.json: ${e.message}`); }
  }
  // env overrides
  const c = {
    zxpSignCmd: process.env.ZXPSIGN_CMD || cfg.zxpSignCmd,
    cert:       process.env.ZXP_CERT || cfg.cert,
    password:   process.env.ZXP_CERT_PASSWORD || cfg.password,
    timestamp:  process.env.ZXP_TIMESTAMP || cfg.timestamp || 'http://timestamp.digicert.com',
    outDir:     process.env.ZXP_OUT_DIR || cfg.outDir,
    name:       process.env.ZXP_NAME || cfg.name || 'MotionToolbar',
  };
  const missing = ['zxpSignCmd', 'cert', 'password', 'outDir'].filter((k) => !c[k]);
  if (missing.length) {
    fail(
      `Missing config: ${missing.join(', ')}.\n` +
      `Create zxp.local.json (copy zxp.local.example.json) or set env vars.`
    );
  }
  if (!fs.existsSync(c.zxpSignCmd)) fail(`ZXPSignCmd not found at: ${c.zxpSignCmd}`);
  if (!fs.existsSync(c.cert))       fail(`Certificate not found at: ${c.cert}`);
  return c;
}

// ---- version handling -------------------------------------------------------
function readVersion() {
  const xml = fs.readFileSync(MANIFEST, 'utf8');
  const m = xml.match(/ExtensionBundleVersion="([^"]+)"/);
  if (!m) fail('Could not read ExtensionBundleVersion from manifest.');
  return m[1];
}

function writeVersion(next) {
  if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`--version must be x.y.z, got "${next}"`);
  const xml = fs.readFileSync(MANIFEST, 'utf8')
    .replace(/(ExtensionBundleVersion=")[^"]+(")/, `$1${next}$2`);
  fs.writeFileSync(MANIFEST, xml, 'utf8');
}

// ---- staging ----------------------------------------------------------------
function stage() {
  fs.rmSync(STAGING, { recursive: true, force: true });
  fs.mkdirSync(STAGING, { recursive: true });
  for (const dir of RUNTIME) {
    const from = path.join(ROOT, dir);
    if (!fs.existsSync(from)) fail(`Runtime folder missing: ${dir} (did the build run?)`);
    fs.cpSync(from, path.join(STAGING, dir), { recursive: true });
  }
  // Prune source/temp files that leak into dist from public/.
  pruneJunk(path.join(STAGING, 'dist'));
}

function pruneJunk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { pruneJunk(p); continue; }
    if (/\.ai$/i.test(entry.name) || /^~ai-.*\.tmp$/i.test(entry.name)) {
      fs.rmSync(p, { force: true });
    }
  }
}

// ---- sign -------------------------------------------------------------------
function sign(cfg, version) {
  fs.mkdirSync(cfg.outDir, { recursive: true });
  const out = path.join(cfg.outDir, `${cfg.name}-${version}.zxp`);
  fs.rmSync(out, { force: true });
  const args = ['-sign', STAGING, out, cfg.cert, cfg.password];
  if (cfg.timestamp) args.push('-tsa', cfg.timestamp);
  execFileSync(cfg.zxpSignCmd, args, { stdio: 'inherit' });
  return out;
}

// ---- helpers ----------------------------------------------------------------
function fail(msg) { console.error(`\n[package-zxp] ${msg}\n`); process.exit(1); }

function parseArgs() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--version');
  return { setVersion: i >= 0 ? args[i + 1] : null };
}

// ---- main -------------------------------------------------------------------
const { setVersion } = parseArgs();
const cfg = loadConfig();
if (setVersion) writeVersion(setVersion);
const version = readVersion();

console.log(`[package-zxp] packaging MTAG v${version}`);
stage();
const out = sign(cfg, version);
const sizeMb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
console.log(`\n[package-zxp] ✔ signed → ${out} (${sizeMb} MB)`);
