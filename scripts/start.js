const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const configPath = path.join(__dirname, '..', 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('Missing config.json — copy config.example.json and fill it in');
  process.exit(1);
}

const { starboundPath } = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!starboundPath) {
  console.error('config.json is missing starboundPath');
  process.exit(1);
}

const platformDir = process.platform === 'darwin' ? 'osx' : 'linux64';
const serverDir = path.join(starboundPath, platformDir);
const serverBin = path.join(serverDir, 'starbound_server');

if (!fs.existsSync(serverBin)) {
  console.error(`Server binary not found: ${serverBin}`);
  process.exit(1);
}

console.log(`Starting Starbound server (${platformDir})...`);

const proc = spawn('./starbound_server', [], {
  cwd: serverDir,
  stdio: 'inherit',
});

proc.on('exit', (code) => process.exit(code ?? 0));
