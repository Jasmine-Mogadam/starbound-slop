#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const STEAM_APPID = '211820';
const REMOTE_MODS_DIR = '/opt/starbound/storage/game/mods';

const DEFAULT_WORKSHOP_DIRS = [
  path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/workshop/content', STEAM_APPID),
  path.join(os.homedir(), '.steam/steam/steamapps/workshop/content', STEAM_APPID),
  path.join(os.homedir(), '.local/share/Steam/steamapps/workshop/content', STEAM_APPID),
];

function findWorkshopDir() {
  if (process.env.WORKSHOP_DIR) return process.env.WORKSHOP_DIR;
  for (const dir of DEFAULT_WORKSHOP_DIRS) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
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

function ensureMachineRunning() {
  const list = runCapture('flyctl', ['machines', 'list', '--json']);
  if (list.status !== 0) {
    console.error('\nflyctl machines list failed. Has the app been deployed yet?');
    process.exit(1);
  }
  let machines = [];
  try { machines = JSON.parse(list.stdout); } catch {}
  if (!machines.length) {
    console.error('\nNo machines found. Run "npm run deploy" first.');
    process.exit(1);
  }
  const m = machines[0];
  if (m.state !== 'started') {
    console.log(`  starting machine ${m.id} (state was '${m.state}')...`);
    run('flyctl', ['machine', 'start', m.id]);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const probe = spawnSync('flyctl', ['ssh', 'console', '-C', 'true'], { stdio: 'ignore' });
      if (probe.status === 0) break;
      spawnSync('sleep', ['2']);
    }
  }
  return m.id;
}

function listLocalMods(workshopDir) {
  const mods = [];
  for (const id of fs.readdirSync(workshopDir)) {
    const pak = path.join(workshopDir, id, 'contents.pak');
    if (!fs.existsSync(pak)) continue;
    const { size } = fs.statSync(pak);
    mods.push({ id, pak, size });
  }
  return mods.sort((a, b) => a.id.localeCompare(b.id));
}

function listRemoteMods() {
  // Output format: "<size> <name>" one per line. Suppress errors so missing dir = empty list.
  const cmd = `mkdir -p ${REMOTE_MODS_DIR} && find ${REMOTE_MODS_DIR} -maxdepth 1 -type f -printf '%s %f\\n'`;
  const res = runCapture('flyctl', ['ssh', 'console', '-C', `bash -c "${cmd}"`]);
  if (res.status !== 0) {
    console.error('\nFailed to list remote mods:');
    console.error(res.stderr);
    process.exit(1);
  }
  const remote = new Map();
  for (const line of res.stdout.split('\n')) {
    const m = line.match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    remote.set(m[2].trim(), parseInt(m[1], 10));
  }
  return remote;
}

const workshopDir = findWorkshopDir();
if (!workshopDir) {
  console.error('\nWorkshop directory not found. Set WORKSHOP_DIR env var to override.');
  process.exit(1);
}
console.log(`\n==> Local workshop: ${workshopDir}`);

const localMods = listLocalMods(workshopDir);
const totalBytes = localMods.reduce((s, m) => s + m.size, 0);
console.log(`  ${localMods.length} mods, ${(totalBytes / 1024 / 1024).toFixed(1)} MiB total`);

console.log('\n==> Ensuring Fly machine is running...');
const machineId = ensureMachineRunning();

console.log('\n==> Checking server mod state...');
const remoteMods = listRemoteMods();
console.log(`  ${remoteMods.size} mods currently on server`);

const toUpload = localMods.filter(m => {
  const remoteName = `${m.id}.pak`;
  const remoteSize = remoteMods.get(remoteName);
  return remoteSize !== m.size;
});

const localNames = new Set(localMods.map(m => `${m.id}.pak`));
const toDelete = [...remoteMods.keys()].filter(name => !localNames.has(name));

console.log(`\n==> Sync plan: upload ${toUpload.length}, delete ${toDelete.length}, skip ${localMods.length - toUpload.length}`);

if (toDelete.length) {
  console.log(`\n==> Removing ${toDelete.length} stale mods from server...`);
  const rmCmd = toDelete.map(n => `rm -f ${REMOTE_MODS_DIR}/${n}`).join('; ');
  run('flyctl', ['ssh', 'console', '-C', `bash -c "${rmCmd}"`]);
}

if (toUpload.length) {
  const uploadBytes = toUpload.reduce((s, m) => s + m.size, 0);
  const DIST = path.join(ROOT, 'dist');
  fs.mkdirSync(DIST, { recursive: true });

  // Stage each pak into a flat dir with workshop-id filenames so tar preserves the names we want.
  const STAGE = path.join(DIST, 'mods-stage');
  if (fs.existsSync(STAGE)) fs.rmSync(STAGE, { recursive: true });
  fs.mkdirSync(STAGE);
  for (const m of toUpload) {
    fs.copyFileSync(m.pak, path.join(STAGE, `${m.id}.pak`));
  }

  const ARCHIVE = path.join(DIST, 'mods.tar.gz');
  if (fs.existsSync(ARCHIVE)) fs.unlinkSync(ARCHIVE);
  console.log(`\n==> Bundling ${toUpload.length} mods (${(uploadBytes / 1024 / 1024).toFixed(1)} MiB) into archive...`);
  // Pak files are already compressed; tar without gzip is faster and barely larger.
  run('tar', ['cf', ARCHIVE, '-C', STAGE, '.']);
  fs.rmSync(STAGE, { recursive: true });

  console.log('\n==> Clearing any previous mod upload chunks on server...');
  run('flyctl', ['ssh', 'console', '-C',
    'bash -c "rm -f /opt/starbound/storage/mods.tar.part.*"',
  ]);

  const CHUNK_PREFIX = path.join(DIST, 'mods.tar.part.');
  for (const f of fs.readdirSync(DIST)) {
    if (f.startsWith('mods.tar.part.')) fs.unlinkSync(path.join(DIST, f));
  }
  run('split', ['-b', '20m', ARCHIVE, CHUNK_PREFIX]);
  fs.unlinkSync(ARCHIVE);

  const chunks = fs.readdirSync(DIST)
    .filter(f => f.startsWith('mods.tar.part.'))
    .sort()
    .map(f => path.join(DIST, f));

  console.log(`\n==> Uploading ${chunks.length} chunks via SFTP...`);
  for (let i = 0; i < chunks.length; i++) {
    const local = chunks[i];
    const remote = `/opt/starbound/storage/${path.basename(local)}`;
    process.stdout.write(`  [${i + 1}/${chunks.length}] ${path.basename(local)}...`);
    run('flyctl', ['sftp', 'put', local, remote]);
    fs.unlinkSync(local);
    process.stdout.write(' done\n');
  }

  console.log('\n==> Extracting mods on server...');
  const extractCmd =
    `cat /opt/starbound/storage/mods.tar.part.* > /opt/starbound/storage/mods.tar && ` +
    `rm /opt/starbound/storage/mods.tar.part.* && ` +
    `mkdir -p ${REMOTE_MODS_DIR} && ` +
    `tar xf /opt/starbound/storage/mods.tar -C ${REMOTE_MODS_DIR} && ` +
    `rm /opt/starbound/storage/mods.tar`;
  run('flyctl', ['ssh', 'console', '-C', `bash -c "${extractCmd}"`]);
}

if (!toUpload.length && !toDelete.length) {
  console.log('\nNothing to sync. Mods are already up to date.');
  process.exit(0);
}

console.log('\n==> Restarting machine so the server picks up mod changes...');
run('flyctl', ['machine', 'restart', machineId]);

console.log('\n==> Done! Watch the server load mods with: npm run logs:fly');
