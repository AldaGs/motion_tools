// Cut a GitHub Release for MTAG and publish the signed .zxp as a downloadable
// asset. This is the "auto-publish" path: the Gumroad product just links to the
// releases page (all versions) and the stable latest-download URL, so shipping
// a new build never requires touching Gumroad.
//
//   npm run release -- --version 1.0.3            bump, build, sign, tag, publish
//   npm run release                                 release the current manifest version
//   npm run release -- --version 1.0.3 --notes "Fixes X"
//   npm run release -- --notes-file CHANGELOG-1.0.3.md
//   npm run release -- --version 1.0.3 --pre       mark as a pre-release
//   npm run release -- --version 1.0.3 --dry-run   do everything except push/publish
//
// Each release carries TWO assets:
//   • MotionToolbar-<version>.zxp   → permanent, version-specific download
//   • MotionToolbar-latest.zxp      → same bytes, constant name, so the URL
//                                      .../releases/latest/download/MotionToolbar-latest.zxp
//                                      always resolves to the newest build.
//
// Buyer-facing URLs (printed at the end):
//   All versions : https://github.com/<slug>/releases
//   Latest (page): https://github.com/<slug>/releases/latest
//   Latest (file): https://github.com/<slug>/releases/latest/download/MotionToolbar-latest.zxp
//   This version : https://github.com/<slug>/releases/download/v<version>/MotionToolbar-<version>.zxp
//
// Requires the GitHub CLI (`gh`), authenticated: `gh auth login`.
// Signing config (outDir, name) is read from the same gitignored zxp.local.json
// that package-zxp.mjs uses.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'CSXS', 'manifest.xml');
const IS_WIN = process.platform === 'win32';

function fail(msg) { console.error(`\n[release] ${msg}\n`); process.exit(1); }

// Run a command, inheriting stdio; fail() on non-zero exit.
function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  } catch (e) {
    fail(`command failed: ${cmd} ${args.join(' ')}\n${e.message}`);
  }
}
// Run a command and capture trimmed stdout.
function capture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', cwd: ROOT, ...opts }).trim();
}
function has(cmd) {
  try { execFileSync(IS_WIN ? 'where' : 'which', [cmd], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// ---- args -------------------------------------------------------------------
function parseArgs() {
  const a = process.argv.slice(2);
  const val = (flag) => { const i = a.indexOf(flag); return i >= 0 ? a[i + 1] : null; };
  return {
    setVersion: val('--version'),
    notes:      val('--notes'),
    notesFile:  val('--notes-file'),
    pre:        a.includes('--pre'),
    dryRun:     a.includes('--dry-run'),
  };
}

// ---- config (subset of package-zxp.mjs) ------------------------------------
function loadConfig() {
  const file = path.join(ROOT, 'zxp.local.json');
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { fail(`Could not parse zxp.local.json: ${e.message}`); }
  }
  const outDir = process.env.ZXP_OUT_DIR || cfg.outDir;
  const name = process.env.ZXP_NAME || cfg.name || 'MotionToolbar';
  if (!outDir) fail('Missing outDir (zxp.local.json or ZXP_OUT_DIR).');
  return { outDir, name };
}

function readVersion() {
  const m = fs.readFileSync(MANIFEST, 'utf8').match(/ExtensionBundleVersion="([^"]+)"/);
  if (!m) fail('Could not read ExtensionBundleVersion from manifest.');
  return m[1];
}

// owner/repo from the origin remote (https or ssh form).
function repoSlug() {
  const url = capture('git', ['remote', 'get-url', 'origin']);
  const m = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (!m) fail(`Could not parse GitHub slug from origin: ${url}`);
  return m[1];
}

// ---- main -------------------------------------------------------------------
const args = parseArgs();
if (!has('gh')) {
  fail('GitHub CLI not found. Install it (winget install GitHub.cli) then run `gh auth login`.');
}
if (args.setVersion && !/^\d+\.\d+\.\d+$/.test(args.setVersion)) {
  fail(`--version must be x.y.z, got "${args.setVersion}"`);
}

const cfg = loadConfig();
const slug = repoSlug();

// 1) Build + sign (package-zxp.mjs bumps the manifest when --version is given).
const pkgArgs = ['run', 'package'];
if (args.setVersion) pkgArgs.push('--', '--version', args.setVersion);
console.log(`[release] packaging${args.setVersion ? ` v${args.setVersion}` : ''}…`);
// shell:true so Windows can spawn npm.cmd — Node ≥18.20 throws EINVAL when
// execFile'ing a .cmd/.bat directly (CVE-2024-27980).
run('npm', pkgArgs, { shell: true });

const version = readVersion();
const tag = `v${version}`;

// 2) Locate the signed asset and make a constant-named copy for the latest URL.
const versioned = path.join(cfg.outDir, `${cfg.name}-${version}.zxp`);
if (!fs.existsSync(versioned)) fail(`Signed asset not found: ${versioned}`);
const latest = path.join(cfg.outDir, `${cfg.name}-latest.zxp`);
fs.copyFileSync(versioned, latest);

// 3) Commit the manifest bump so the tag points at the released version.
const dirtyManifest = capture('git', ['status', '--porcelain', '--', 'CSXS/manifest.xml']);
if (dirtyManifest) {
  if (args.dryRun) {
    console.log(`[release] (dry-run) would commit manifest bump for ${tag}`);
  } else {
    run('git', ['add', 'CSXS/manifest.xml']);
    run('git', ['commit', '-m', `chore(release): ${tag}`]);
    run('git', ['push']);
  }
}

// 4) Guard against re-tagging an existing release.
const existing = (() => {
  try { execFileSync('gh', ['release', 'view', tag], { stdio: 'ignore', cwd: ROOT }); return true; }
  catch { return false; }
})();
if (existing) fail(`Release ${tag} already exists. Bump --version or delete the old release.`);

// 5) Publish.
const ghArgs = ['release', 'create', tag, versioned, latest, '--title', `MTAG ${version}`];
if (args.notesFile)      ghArgs.push('--notes-file', args.notesFile);
else if (args.notes)     ghArgs.push('--notes', args.notes);
else                     ghArgs.push('--generate-notes');
if (args.pre)            ghArgs.push('--prerelease');

if (args.dryRun) {
  console.log(`[release] (dry-run) would run: gh ${ghArgs.join(' ')}`);
} else {
  console.log(`[release] creating GitHub release ${tag}…`);
  run('gh', ghArgs);
}

// ---- buyer-facing URLs ------------------------------------------------------
const base = `https://github.com/${slug}`;
console.log(`
[release] ✔ ${args.dryRun ? '(dry-run) ' : ''}published ${tag}

  Paste these into the Gumroad product content:
    All versions : ${base}/releases
    Latest (page): ${base}/releases/latest
    Latest (file): ${base}/releases/latest/download/${cfg.name}-latest.zxp
    This version : ${base}/releases/download/${tag}/${cfg.name}-${version}.zxp
`);
