#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GAME_DIR = path.join(ROOT, 'starbound-server-files');
const MODS_DIR = path.join(GAME_DIR, 'mods');
const DIST = path.join(ROOT, 'dist');
const ARCHIVE = path.join(DIST, 'game.tar.gz');
const CHUNK_PREFIX = path.join(DIST, 'game.tar.gz.part.');
const STEAMCMD_IMAGE = 'starbound-steamcmd:local';
const STEAM_APPID = '211820';

const DEFAULT_WORKSHOP_DIRS = [
  path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/workshop/content', STEAM_APPID),
  path.join(os.homedir(), '.steam/steam/steamapps/workshop/content', STEAM_APPID),
  path.join(os.homedir(), '.local/share/Steam/steamapps/workshop/content', STEAM_APPID),
];

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.error) {
    console.error(`\nFailed to run '${cmd}': ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n'${cmd}' exited with code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

function runCapture(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8' });
}

function ensureSteamCmdImage() {
  const check = spawnSync('docker', ['image', 'inspect', STEAMCMD_IMAGE], { stdio: 'ignore' });
  if (check.status === 0) return;
  console.log('  Building local steamcmd image (one-time)...');
  run('docker', [
    'build', '--platform', 'linux/amd64',
    '-t', STEAMCMD_IMAGE,
    '-f', path.join(ROOT, 'Dockerfile.steamcmd'),
    ROOT,
  ]);
}

function findSteamCmd() {
  for (const c of ['steamcmd', '/usr/local/bin/steamcmd', '/opt/homebrew/bin/steamcmd']) {
    const r = spawnSync(c, ['+quit'], { stdio: 'ignore' });
    if (!r.error) return c;
  }
  return null;
}

function downloadGame(steamUser, steamPass) {
  const absGameDir = path.resolve(GAME_DIR);
  const ttyFlags = process.stdin.isTTY ? ['-it'] : [];

  const steamcmd = findSteamCmd();
  if (steamcmd) {
    console.log(`  using native ${steamcmd}`);
    run(steamcmd, [
      '+@sSteamCmdForcePlatformType', 'linux',
      '+login', steamUser, steamPass,
      '+force_install_dir', absGameDir,
      '+app_update', '211820', 'validate',
      '+quit',
    ]);
    return;
  }

  const dockerCheck = spawnSync('docker', ['info'], { stdio: 'ignore' });
  if (dockerCheck.error || dockerCheck.status !== 0) {
    console.error(
      'Error: steamcmd not found and Docker is not available.\n' +
      'Install steamcmd: brew install steamcmd'
    );
    process.exit(1);
  }

  console.log('  using Docker DepotDownloader (enter Steam Guard code if prompted)');
  ensureSteamCmdImage();
  run('docker', [
    'run', '--rm', ...ttyFlags,
    '-v', `${absGameDir}:/output`,
    'starbound-steamcmd:local',
    '-app', '211820',
    '-username', steamUser,
    '-password', steamPass,
    '-dir', '/output',
    '-os', 'linux',
    '-osarch', '64',
    '-validate',
  ]);
}

function findWorkshopDir() {
  if (process.env.WORKSHOP_DIR) return process.env.WORKSHOP_DIR;
  for (const dir of DEFAULT_WORKSHOP_DIRS) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

function stageWorkshopMods() {
  if (process.env.SKIP_MODS) {
    console.log('  SKIP_MODS set, skipping workshop mod sync');
    return;
  }
  const workshopDir = findWorkshopDir();
  if (!workshopDir) {
    console.log('  no Steam workshop dir found, skipping mod sync (set WORKSHOP_DIR to override)');
    return;
  }
  fs.mkdirSync(MODS_DIR, { recursive: true });

  const wanted = new Map(); // id.pak -> { src, size }
  for (const id of fs.readdirSync(workshopDir)) {
    const src = path.join(workshopDir, id, 'contents.pak');
    if (!fs.existsSync(src)) continue;
    wanted.set(`${id}.pak`, { src, size: fs.statSync(src).size });
  }

  // Drop placeholder file from a fresh checkout, and any stale paks no longer subscribed.
  for (const f of fs.readdirSync(MODS_DIR)) {
    if (f === 'mods_go_here') {
      fs.unlinkSync(path.join(MODS_DIR, f));
      continue;
    }
    if (!f.endsWith('.pak')) continue;
    if (!wanted.has(f)) fs.unlinkSync(path.join(MODS_DIR, f));
  }

  let copied = 0;
  let totalBytes = 0;
  for (const [name, { src, size }] of wanted) {
    const dst = path.join(MODS_DIR, name);
    if (fs.existsSync(dst) && fs.statSync(dst).size === size) continue;
    fs.copyFileSync(src, dst);
    copied++;
    totalBytes += size;
  }
  console.log(`  ${wanted.size} workshop mods staged (${copied} copied/updated, ${(totalBytes / 1024 / 1024).toFixed(1)} MiB)`);
}

function cleanStaleChunks() {
  if (!fs.existsSync(DIST)) return;
  for (const f of fs.readdirSync(DIST)) {
    if (f === 'game.tar.gz' || f.startsWith('game.tar.gz.part.')) {
      fs.unlinkSync(path.join(DIST, f));
    }
  }
}

function ensureMachineRunning() {
  // Find a machine for the app and start it if not already started. Required for sftp/ssh.
  const list = runCapture('flyctl', ['machines', 'list', '--json']);
  if (list.status !== 0) {
    console.error('\nflyctl machines list failed. Has the app been deployed yet?');
    console.error('Run: npm run deploy   (first deploy creates the machine)');
    process.exit(1);
  }
  let machines;
  try { machines = JSON.parse(list.stdout); } catch { machines = []; }
  if (!machines.length) {
    console.error('\nNo machines found for app. Run "npm run deploy" first to create one.');
    process.exit(1);
  }
  const m = machines[0];
  if (m.state === 'started') {
    console.log(`  machine ${m.id} already started`);
    return m.id;
  }
  console.log(`  starting machine ${m.id} (state was '${m.state}')...`);
  run('flyctl', ['machine', 'start', m.id]);
  // wait a moment for ssh to come up
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const probe = spawnSync('flyctl', ['ssh', 'console', '-C', 'true'], { stdio: 'ignore' });
    if (probe.status === 0) return m.id;
    spawnSync('sleep', ['2']);
  }
  console.error('\nTimed out waiting for machine ssh to come up.');
  process.exit(1);
}

const env = loadEnv();
const { STEAM_USER, STEAM_PASS } = env;
if (!STEAM_USER || !STEAM_PASS) {
  console.error('Error: STEAM_USER and STEAM_PASS must be set in .env');
  process.exit(1);
}

console.log('\n==> Cleaning previous build artifacts...');
cleanStaleChunks();

console.log('\n==> Downloading Starbound (linux)...');
fs.mkdirSync(GAME_DIR, { recursive: true });
downloadGame(STEAM_USER, STEAM_PASS);

console.log('\n==> Staging Steam workshop mods into starbound-server-files/mods/...');
stageWorkshopMods();

console.log('\n==> Creating game archive...');
fs.mkdirSync(DIST, { recursive: true });
run('tar', [
  'czf', ARCHIVE,
  '--exclude=./storage',
  '--exclude=./win32',
  '--exclude=./win64',
  '--exclude=./osx',
  '-C', GAME_DIR,
  '.',
]);
console.log('Archive created.');

console.log('\n==> Ensuring Fly machine is running...');
const machineId = ensureMachineRunning();

console.log('\n==> Clearing any previous upload chunks on server...');
run('flyctl', ['ssh', 'console', '-C',
  'bash -c "rm -f /opt/starbound/storage/game.tar.gz /opt/starbound/storage/game.tar.gz.part.*"',
]);

console.log('\n==> Splitting archive for chunked upload...');
// Split into 20MB chunks to stay under Fly's SFTP connection limit
run('split', ['-b', '20m', ARCHIVE, CHUNK_PREFIX]);
fs.unlinkSync(ARCHIVE);

const chunks = fs.readdirSync(DIST)
  .filter(f => f.startsWith('game.tar.gz.part.'))
  .sort()
  .map(f => path.join(DIST, f));

console.log(`\n==> Uploading ${chunks.length} chunks via SFTP (this may take a while)...`);
for (let i = 0; i < chunks.length; i++) {
  const local = chunks[i];
  const remote = `/opt/starbound/storage/${path.basename(local)}`;
  process.stdout.write(`  [${i + 1}/${chunks.length}] ${path.basename(local)}...`);
  run('flyctl', ['sftp', 'put', local, remote]);
  fs.unlinkSync(local);
  process.stdout.write(' done\n');
}

console.log('\n==> Reassembling chunks on server...');
run('flyctl', ['ssh', 'console', '-C',
  'bash -c "cat /opt/starbound/storage/game.tar.gz.part.* > /opt/starbound/storage/game.tar.gz && rm /opt/starbound/storage/game.tar.gz.part.*"',
]);

console.log('\n==> Restarting machine so entrypoint extracts the new archive...');
run('flyctl', ['machine', 'restart', machineId]);

console.log('\n==> Done! Watch the server come up with: npm run logs:fly');
console.log('    Connect from Starbound to: starbound-server.fly.dev:21025');
