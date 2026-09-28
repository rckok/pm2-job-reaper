'use strict';

// Test app for pm2-job-reaper. It spawns:
//   - a direct child (ping -t), which PM2's taskkill /T can reach while this process is alive;
//   - an orphan via `cmd /c start /b`. cmd exits at once, so ping is left with a dead parent,
//     the case taskkill /T can never reach.
// After CRASH_AFTER_MS it throws, so you can watch what survives.

const { spawn } = require('child_process');

const CRASH_AFTER_MS = Number(process.env.CRASH_AFTER_MS || 10000);

spawn('ping', ['-t', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
spawn('cmd', ['/c', 'start', '/b', 'ping', '-t', '127.0.0.2'], { stdio: 'ignore', windowsHide: true });

console.log(`leaky-app pid ${process.pid}: spawned 2 ping processes, crashing in ${CRASH_AFTER_MS} ms`);
setTimeout(() => {
  throw new Error('leaky-app: deliberate crash');
}, CRASH_AFTER_MS);
