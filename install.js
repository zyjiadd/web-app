// Build-time installer: downloads the xray binary and places it next to
// server.js so it is deployed inside /app. This runs as an npm postinstall
// script during the buildpack build, when the app directory is still
// writable. At runtime /app is read-only and the writable dirs are noexec,
// so a binary downloaded at runtime cannot be executed there — it must
// already be in /app at build time.
const https = require('https');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const XRAY_URL = 'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip';
const DEST = path.join(__dirname, 'xray');

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

(async () => {
  if (fs.existsSync(DEST)) {
    console.log('[install] xray binary already present, skipping download');
    try { fs.chmodSync(DEST, 0o755); } catch (e) { /* ignore */ }
    return;
  }
  console.log('[install] downloading xray binary...');
  const zipPath = path.join(__dirname, 'Xray-linux-64.zip');
  await downloadFile(XRAY_URL, zipPath);
  new AdmZip(zipPath).extractEntryTo('xray', __dirname, false, true);
  fs.chmodSync(DEST, 0o755);
  fs.unlinkSync(zipPath);
  console.log('[install] xray binary installed at', DEST);
})().catch((e) => {
  console.error('[install] failed to install xray binary:', e);
  // Do not fail the build: the wrapper falls back to a runtime download.
  process.exit(0);
});
