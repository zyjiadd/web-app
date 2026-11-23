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

// NOTE: cWeb runs the app with a READ-ONLY /app directory, so the xray
// binary cannot be downloaded/extracted next to server.js. Use the user's
// home directory (writable AND executable) for the download and the
// extracted binary. os.tmpdir() (/tmp) is writable but mounted noexec on
// cWeb, so spawning xray from there fails with EACCES even after chmod +x.
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
  if (fs.existsSync(XRAY_BIN)) {
    // Binary already present (e.g. from a previous run) — make sure it is
    // executable, then use it.
    try { fs.chmodSync(XRAY_BIN, 0o755); } catch (e) { /* ignore */ }
    return;
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
}

let xrayProc = null;
function startXray() {
  xrayProc = spawn(XRAY_BIN, ['run', '-config', 'config.json'], { cwd: __dirname, stdio: 'inherit' });
  xrayProc.on('exit', (code) => {
    console.log(`[wrapper] xray exited (${code}), restarting in 5s...`);
    setTimeout(startXray, 5000);
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
  .then(() => startXray())
  .catch((e) => {
    console.error('[wrapper] failed to prepare xray:', e);
    process.exit(1);
  });

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[wrapper] listening on 0.0.0.0:${LISTEN_PORT}, proxying ${WS_PATH} -> 127.0.0.1:${XRAY_PORT}`);
});
