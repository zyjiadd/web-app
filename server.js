// Minimal Node wrapper: listens on the platform-assigned PORT, answers the
// platform readiness check (GET / -> 200), and proxies WebSocket upgrades
// to the local xray process (127.0.0.1:18000). No framework dependency.
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

// The xray binary is installed at BUILD time by install.js (npm postinstall),
// which downloads it and places it next to server.js, so it is deployed
// inside /app. At runtime /app is read-only but NOT noexec, so the binary
// can be executed from there (directly if it has +x, otherwise through the
// dynamic loader, which only needs read permission). A binary downloaded at
// runtime cannot work on cWeb: the writable dirs (/tmp, HOME) are noexec,
// so even the loader cannot map its executable segments there.
const BUNDLED_BIN = path.join(__dirname, 'xray');
// Dynamic loader: runs a binary that only has read permission.
const LOADER = '/lib64/ld-linux-x86-64.so.2';
const XRAY_DIR = os.homedir() || os.tmpdir();
const XRAY_BIN = path.join(XRAY_DIR, 'xray');
const XRAY_ZIP = 'Xray-linux-64.zip';
const XRAY_URL = 'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip';
const XRAY_PORT = 18000;
const WS_PATH = '/api';
const LISTEN_PORT = Number(process.env.PORT) || 3000;

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error('download failed: HTTP ' + res.statusCode));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', reject);
    };
    get(url);
  });
}

async function ensureXray() {
  // Prefer the build-time binary installed by install.js (in /app).
  if (fs.existsSync(BUNDLED_BIN)) {
    try { fs.chmodSync(BUNDLED_BIN, 0o755); } catch (e) { /* /app is read-only; ignore */ }
    console.log('[wrapper] using build-time xray binary');
    return { bin: BUNDLED_BIN, useLoader: false };
  }
  // Fallback: download at runtime (used on platforms that allow it).
  if (fs.existsSync(XRAY_BIN)) {
    // Binary already present (e.g. from a previous run) — make sure it is
    // executable, then use it.
    try { fs.chmodSync(XRAY_BIN, 0o755); } catch (e) { /* ignore */ }
    return { bin: XRAY_BIN, useLoader: false };
  }
  console.log('[wrapper] xray binary missing, downloading...');
  const zipPath = path.join(XRAY_DIR, XRAY_ZIP);
  await downloadFile(XRAY_URL, zipPath);
  // Extract with pure-JS adm-zip: the container has no `unzip` binary
  // (exit 127), which previously crashed the process in a restart loop.
  new AdmZip(zipPath).extractEntryTo('xray', XRAY_DIR, false, true);
  fs.chmodSync(XRAY_BIN, 0o755);
  fs.unlinkSync(zipPath);
  console.log('[wrapper] xray binary ready');
  return { bin: XRAY_BIN, useLoader: false };
}

let xrayProc = null;
let triedLoader = false;
function startXray(target) {
  const { bin: binPath, useLoader } = target;
  const cmd = useLoader ? LOADER : binPath;
  const args = useLoader ? [binPath, 'run', '-config', 'config.json'] : ['run', '-config', 'config.json'];
  xrayProc = spawn(cmd, args, { cwd: __dirname, stdio: 'inherit' });
  xrayProc.on('error', (err) => {
    // If the binary cannot be executed directly (missing +x bit), retry
    // through the dynamic loader, which only needs read permission.
    if (err && err.code === 'EACCES' && !triedLoader && !useLoader && fs.existsSync(LOADER)) {
      triedLoader = true;
      console.log('[wrapper] direct spawn denied (EACCES), retrying via dynamic loader...');
      xrayProc = spawn(LOADER, [binPath, 'run', '-config', 'config.json'], { cwd: __dirname, stdio: 'inherit' });
      xrayProc.on('exit', (code) => {
        console.log(`[wrapper] xray exited (${code}), restarting in 5s...`);
        setTimeout(() => startXray(target), 5000);
      });
      return;
    }
    console.log(`[wrapper] xray spawn error (${err && err.code}), restarting in 5s...`);
    setTimeout(() => startXray(target), 5000);
  });
  xrayProc.on('exit', (code) => {
    console.log(`[wrapper] xray exited (${code}), restarting in 5s...`);
    setTimeout(() => startXray(target), 5000);
  });
}

const server = http.createServer((req, res) => {
  // Readiness check: platform expects a 200 without login.
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});

server.on('upgrade', (req, socket, head) => {
  const url = req.url || '';
  if (url === WS_PATH || url.startsWith(WS_PATH + '?')) {
    // Proxy the raw WS upgrade to xray on 127.0.0.1:18000.
    const proxy = http.request({
      host: '127.0.0.1',
      port: XRAY_PORT,
      path: url,
      method: req.method,
      headers: req.headers,
    });
    proxy.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
        Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
        '\r\n\r\n');
      if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });
    proxy.on('error', () => socket.destroy());
    proxy.end(head);
  } else {
    socket.destroy();
  }
});

ensureXray()
  .then((target) => startXray(target))
  .catch((e) => {
    console.error('[wrapper] failed to prepare xray:', e);
    process.exit(1);
  });

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[wrapper] listening on 0.0.0.0:${LISTEN_PORT}, proxying ${WS_PATH} -> 127.0.0.1:${XRAY_PORT}`);
});
