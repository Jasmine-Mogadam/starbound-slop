#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');

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

console.log('\n==> Deploying to Fly...');
run('flyctl', ['deploy']);
console.log('\n==> Done!');
