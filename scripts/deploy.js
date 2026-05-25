#!/usr/bin/env node
'use strict';

// Single deploy script: download Starbound (if needed), stage workshop mods,
// build one bundle.tar.gz with everything, push docker image, upload bundle to
// Fly volume, restart machine. The entrypoint on the server does extraction.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const GAME_DIR = path.join(ROOT, 'starbound-server-files');
const MODS_DIR = path.join(GAME_DIR, 'mods');
const SERVER_BIN = path.join(GAME_DIR, 'linux', 'starbound_server');
const DIST = path.join(ROOT, 'dist');
const BUNDLE = path.join(DIST, 'bundle.tar.gz');
const CHUNK_PREFIX = path.join(DIST, 'bundle.tar.gz.part.');
const CHUNK_SIZE = '250m';

const STEAMCMD_IMAGE = 'starbound-steamcmd:local';
const STEAM_APPID = '211820';
const TAR_ENV = { ...process.env, COPYFILE_DISABLE: '1' };

const REMOTE_STORAGE = '/opt/starbound/storage';
const REMOTE_BUNDLE = `${REMOTE_STORAGE}/bundle.tar.gz`;
const REMOTE_CHUNK_PREFIX = `${REMOTE_STORAGE}/bundle.tar.gz.part.`;
const REMOTE_SHA = `${REMOTE_STORAGE}/.bundle-sha`;

const WORKSHOP_DIRS = [
  path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/workshop/content', STEAM_APPID),
  path.join(os.homedir(), '.steam/steam/steamapps/workshop/content', STEAM_APPID),
  path.join(os.homedir(), '.local/share/Steam/steamapps/workshop/content', STEAM_APPID),
];

const FORCE_UPLOAD = process.argv.includes('--force-upload');
const REDOWNLOAD = process.argv.includes('--redownload');
const WIPE_REMOTE = process.argv.includes('--wipe');

// ---------- helpers ----------

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) { console.error(`\n${cmd} failed: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) { console.error(`\n${cmd} exited ${r.status}`); process.exit(r.status ?? 1); }
}

function capture(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

function trySpawn(cmd, args) {
  return spawnSync(cmd, args, { stdio: 'ignore' });
}

function sleep(s) { spawnSync('sleep', [String(s)], { stdio: 'ignore' }); }

function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return {};
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}

function findWorkshopDir() {
  if (process.env.WORKSHOP_DIR) return process.env.WORKSHOP_DIR;
  for (const d of WORKSHOP_DIRS) if (fs.existsSync(d)) return d;
  return null;
}

// ---------- steps ----------

function ensureSteamCmdImage() {
  const check = trySpawn('docker', ['image', 'inspect', STEAMCMD_IMAGE]);
  if (check.status === 0) return;
  console.log('  (building local steamcmd image, one-time)');
  run('docker', [
    'build', '--platform', 'linux/amd64',
    '-t', STEAMCMD_IMAGE,
    '-f', path.join(ROOT, 'Dockerfile.steamcmd'),
    ROOT,
  ]);
}

function ensureGameDownloaded(steamUser, steamPass) {
  if (fs.existsSync(SERVER_BIN) && !REDOWNLOAD) {
    console.log('  game files present (pass --redownload to refresh)');
    return;
  }
  console.log('  downloading Starbound (linux) via DepotDownloader...');
  ensureSteamCmdImage();
  fs.mkdirSync(GAME_DIR, { recursive: true });
  const ttyFlags = process.stdin.isTTY ? ['-it'] : [];
  run('docker', [
    'run', '--rm', ...ttyFlags,
    '-v', `${path.resolve(GAME_DIR)}:/output`,
    STEAMCMD_IMAGE,
    '-app', STEAM_APPID,
    '-username', steamUser, '-password', steamPass,
    '-dir', '/output', '-os', 'linux', '-osarch', '64', '-validate',
  ]);
}

function stageWorkshopMods() {
  if (process.env.SKIP_MODS) { console.log('  SKIP_MODS set; skipping'); return; }
  const wsDir = findWorkshopDir();
  if (!wsDir) { console.log('  no Steam workshop dir found; skipping'); return; }
  fs.mkdirSync(MODS_DIR, { recursive: true });

  const wanted = new Map();
  for (const id of fs.readdirSync(wsDir)) {
    const src = path.join(wsDir, id, 'contents.pak');
    if (!fs.existsSync(src)) continue;
    wanted.set(`${id}.pak`, { src, size: fs.statSync(src).size });
  }

  // Scrub the local staging dir: drop placeholder, AppleDouble sidecars, stale paks.
  for (const f of fs.readdirSync(MODS_DIR)) {
    if (f === 'mods_go_here' || f.startsWith('._')) {
      fs.unlinkSync(path.join(MODS_DIR, f));
      continue;
    }
    if (f.endsWith('.pak') && !wanted.has(f)) {
      fs.unlinkSync(path.join(MODS_DIR, f));
    }
  }

  let copied = 0;
  for (const [name, { src, size }] of wanted) {
    const dst = path.join(MODS_DIR, name);
    if (fs.existsSync(dst) && fs.statSync(dst).size === size) continue;
    fs.copyFileSync(src, dst);
    copied++;
  }
  console.log(`  ${wanted.size} workshop mods staged (${copied} new/changed)`);
}

function cleanDistArtifacts() {
  if (!fs.existsSync(DIST)) return;
  for (const f of fs.readdirSync(DIST)) {
    if (f === 'bundle.tar.gz' || f.startsWith('bundle.tar.gz.part.')) {
      fs.unlinkSync(path.join(DIST, f));
    }
  }
}

function buildBundle() {
  fs.mkdirSync(DIST, { recursive: true });
  cleanDistArtifacts();
  run('tar', [
    'czf', BUNDLE,
    '--exclude=./storage',
    '--exclude=./win32', '--exclude=./win64', '--exclude=./osx',
    '--exclude=._*',
    '-C', GAME_DIR, '.',
  ], { env: TAR_ENV });
  const sz = fs.statSync(BUNDLE).size;
  console.log(`  bundle: ${(sz / 1024 / 1024 / 1024).toFixed(2)} GiB`);
}

function bundleSha() {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(BUNDLE, 'r');
  const buf = Buffer.alloc(4 * 1024 * 1024);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}

function getMachineId() {
  const r = capture('flyctl', ['machines', 'list', '--json']);
  if (r.status !== 0) return null;
  try {
    const arr = JSON.parse(r.stdout);
    return arr[0]?.id ?? null;
  } catch { return null; }
}

function waitForSsh(machineId, timeoutSec = 180) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const r = trySpawn('flyctl', ['ssh', 'console', '--machine', machineId, '-C', 'true']);
    if (r.status === 0) return;
    sleep(3);
  }
  console.error(`Machine ${machineId} never became SSH-reachable.`);
  process.exit(1);
}

// flyctl ssh -C runs the command directly without a login shell, so globs, redirects,
// and chained commands don't get expanded. Always wrap in `bash -c '<cmd>'`.
function shellWrap(cmd) {
  // Escape single quotes for the outer bash -c '...'
  return `bash -c '${cmd.replace(/'/g, `'\\''`)}'`;
}

function ssh(cmd, opts = { retries: 3 }) {
  const wrapped = shellWrap(cmd);
  for (let i = 0; i < opts.retries; i++) {
    const r = spawnSync('flyctl', ['ssh', 'console', '-C', wrapped], { stdio: 'inherit' });
    if (r.status === 0) return;
    if (i < opts.retries - 1) { console.warn(`  ssh failed, retrying in 3s...`); sleep(3); }
  }
  console.error(`ssh failed: ${cmd}`);
  process.exit(1);
}

function sshCapture(cmd) {
  return capture('flyctl', ['ssh', 'console', '-C', shellWrap(cmd)]);
}

function sftpPut(local, remote, retries = 3) {
  for (let i = 0; i < retries; i++) {
    if (i > 0) ssh(`rm -f ${remote}`); // sftp put won't overwrite an existing file
    const r = spawnSync('flyctl', ['sftp', 'put', local, remote], { stdio: 'inherit' });
    if (r.status === 0) return;
    if (i < retries - 1) { console.warn(`  sftp put failed, retrying in 3s...`); sleep(3); }
  }
  console.error(`sftp put failed: ${path.basename(local)}`);
  process.exit(1);
}

function getRemoteSha() {
  const r = sshCapture(`cat ${REMOTE_SHA} 2>/dev/null || true`);
  const m = (r.stdout || '').match(/[a-f0-9]{64}/);
  return m ? m[0] : null;
}

function uploadBundle() {
  console.log('  clearing stale server-side bundle/chunks...');
  ssh(`rm -f ${REMOTE_BUNDLE} ${REMOTE_CHUNK_PREFIX}* ${REMOTE_SHA}`);

  console.log(`  splitting bundle into ${CHUNK_SIZE} chunks...`);
  run('split', ['-b', CHUNK_SIZE, BUNDLE, CHUNK_PREFIX]);
  fs.unlinkSync(BUNDLE);

  const chunks = fs.readdirSync(DIST)
    .filter(f => f.startsWith('bundle.tar.gz.part.'))
    .sort()
    .map(f => path.join(DIST, f));

  const totalBytes = chunks.reduce((s, f) => s + fs.statSync(f).size, 0);
  let uploaded = 0;
  console.log(`  uploading ${chunks.length} chunks (${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GiB total)...`);
  const start = Date.now();
  for (let i = 0; i < chunks.length; i++) {
    const local = chunks[i];
    const remote = `${REMOTE_STORAGE}/${path.basename(local)}`;
    const sz = fs.statSync(local).size;
    const sizeMiB = (sz / 1024 / 1024).toFixed(0);
    const pct = ((uploaded / totalBytes) * 100).toFixed(0);
    const elapsed = (Date.now() - start) / 1000;
    const eta = uploaded > 0 ? Math.round((totalBytes - uploaded) / (uploaded / elapsed)) : 0;
    const etaStr = uploaded > 0 ? ` (${Math.round(eta / 60)}m ETA)` : '';
    console.log(`    [${i + 1}/${chunks.length}] ${path.basename(local)} ${sizeMiB} MiB — ${pct}% done${etaStr}`);
    sftpPut(local, remote);
    fs.unlinkSync(local);
    uploaded += sz;
  }
}

// ---------- main ----------

const env = loadEnv();
const { STEAM_USER, STEAM_PASS } = env;
if (!STEAM_USER || !STEAM_PASS) {
  console.error('Error: STEAM_USER and STEAM_PASS must be set in .env');
  process.exit(1);
}

console.log('\n==> [1/6] Ensure local Starbound files present');
ensureGameDownloaded(STEAM_USER, STEAM_PASS);

console.log('\n==> [2/6] Stage workshop mods');
stageWorkshopMods();

console.log('\n==> [3/6] Build bundle archive');
buildBundle();
const sha = bundleSha();
console.log(`  sha256: ${sha.slice(0, 16)}...`);

console.log('\n==> [4/6] Push docker image (flyctl deploy)');
run('flyctl', ['deploy']);

console.log('\n==> [5/6] Upload bundle to volume');
const machineId = getMachineId();
if (!machineId) { console.error('No machine found after deploy. Aborting.'); process.exit(1); }

// flyctl deploy may have left the machine in 'stopped' (it does so when starbound exits
// during the rolling deploy). Make sure it's running so we can SFTP.
const ms = capture('flyctl', ['machines', 'list', '--json']);
let state = 'unknown';
try { state = JSON.parse(ms.stdout)[0]?.state || state; } catch {}
if (state !== 'started') {
  console.log(`  machine state is '${state}', starting...`);
  run('flyctl', ['machine', 'start', machineId]);
}
waitForSsh(machineId);

if (WIPE_REMOTE) {
  console.log('  --wipe set: removing existing game/ on volume...');
  ssh(`rm -rf ${REMOTE_STORAGE}/game`);
}

const remoteSha = FORCE_UPLOAD ? null : getRemoteSha();
if (remoteSha === sha) {
  console.log(`  bundle unchanged (sha matches remote). Skipping upload.`);
  fs.unlinkSync(BUNDLE);
} else {
  if (remoteSha) console.log(`  bundle changed (remote=${remoteSha.slice(0, 8)}, local=${sha.slice(0, 8)})`);
  uploadBundle();
  console.log('  reassembling chunks on server...');
  ssh(`cat ${REMOTE_CHUNK_PREFIX}* > ${REMOTE_BUNDLE} && rm ${REMOTE_CHUNK_PREFIX}*`);
  ssh(`echo ${sha} > ${REMOTE_SHA}`);
}

console.log('\n==> [6/6] Restart machine (entrypoint extracts and launches)');
// If a prior debug session set SAFE_MODE, stage-unset it so the next restart launches starbound.
const secretsList = capture('flyctl', ['secrets', 'list', '--json']);
try {
  const hasSafe = JSON.parse(secretsList.stdout || '[]').some(s => s.Name === 'SAFE_MODE');
  if (hasSafe) {
    console.log('  SAFE_MODE secret detected; unsetting (stage) so the restart will launch starbound...');
    run('flyctl', ['secrets', 'unset', 'SAFE_MODE', '--stage']);
  }
} catch {}
run('flyctl', ['machine', 'restart', machineId]);

console.log('\nDone. Tail logs with: npm run logs:fly');
console.log('Connect from Starbound to: starbound-server.fly.dev:21025');
