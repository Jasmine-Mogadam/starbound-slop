const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('Missing config.json — copy config.example.json and fill it in');
  process.exit(1);
}

const { starboundPath, workshopPath } = JSON.parse(fs.readFileSync(configPath, 'utf8'));

if (!starboundPath) {
  console.error('config.json is missing starboundPath');
  process.exit(1);
}

const buildDir = path.join(__dirname, '..', '.build', 'server');
fs.rmSync(buildDir, { recursive: true, force: true });
fs.mkdirSync(buildDir, { recursive: true });

function copy(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`  skipping (not found): ${src}`);
    return;
  }
  console.log(`  copying ${src}`);
  fs.cpSync(src, dest, { recursive: true });
}

console.log('Preparing server files...');
copy(path.join(starboundPath, 'linux64'), path.join(buildDir, 'linux64'));
copy(path.join(starboundPath, 'assets'),  path.join(buildDir, 'assets'));

// local mods folder from the game install
const localMods = path.join(starboundPath, 'mods');
if (fs.existsSync(localMods)) {
  copy(localMods, path.join(buildDir, 'mods'));
}

// workshop mods
if (workshopPath && fs.existsSync(workshopPath)) {
  console.log(`Copying workshop mods from ${workshopPath}`);
  const modsOut = path.join(buildDir, 'mods');
  fs.mkdirSync(modsOut, { recursive: true });
  for (const id of fs.readdirSync(workshopPath)) {
    copy(path.join(workshopPath, id), path.join(modsOut, id));
  }
}

console.log('Done — .build/server is ready');
