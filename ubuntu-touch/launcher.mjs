// Ubuntu Touch entry point (runs under the app's AppArmor confinement, so no shell tools):
// start the TV service in-process on localhost, then show the remote in a web-app window.
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const APP_ID = 'tvremote.local';
const PORT = 18787;
process.env.DATA_DIR = path.join(os.homedir(), '.local/share', APP_ID);
process.env.HOST = '127.0.0.1';
process.env.PORT = String(PORT);
mkdirSync(process.env.DATA_DIR, { recursive: true });

const up = () => new Promise((resolve) => {
  http.get(`http://127.0.0.1:${PORT}/api/info`, (res) => { res.resume(); resolve(res.statusCode === 200); })
    .on('error', () => resolve(false));
});

// Reuse a copy that is still running (e.g. after the window was closed abruptly).
if (!(await up())) await import('./server.js');
for (let i = 0; i < 50 && !(await up()); i++) await new Promise((r) => setTimeout(r, 100));

const url = `http://127.0.0.1:${PORT}/`;
const ui = spawn('/usr/bin/webapp-container', [`--app-id=${APP_ID}`, '--store-session-cookies', `--webappUrlPatterns=${url}*`, url], { stdio: 'inherit' });
ui.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { ui.kill(sig); process.exit(0); });
