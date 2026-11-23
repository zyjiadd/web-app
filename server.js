// Minimal Node wrapper: listens on the platform-assigned PORT, answers the
// platform readiness check (GET / -> 200), and proxies WebSocket upgrades
// to the local xray process (127.0.0.1:18000). No framework dependency.
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

// NOTE: cWeb runs the app with a READ-ONLY /app directory, so the xray
// binary cannot be downloaded/extracted next to server.js. Use the OS temp
// dir (writable) for the download and the extracted binary instead.
const XRAY_DIR = os.tmpdir();
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
  if (fs.existsSync(XRAY_BIN)) return;
  console.log('[wrapper] xray binary missing, downloading...');
  const zipPath = path.join(XRAY_DIR, XRAY_ZIP);
  await downloadFile(XRAY_URL, zipPath);
  execSync(`unzip -o ${XRAY_ZIP} xray && chmod +x xray && rm -f ${XRAY_ZIP}`, { cwd: XRAY_DIR, stdio: 'inherit' });
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
