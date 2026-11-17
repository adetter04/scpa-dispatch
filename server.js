// Launcher: `node server.js` (or `npm start`) -> http://localhost:8787
// Lebanon's server omits its GoDaddy intermediate certificate. Browsers fill that gap; Node won't,
// so we restart with the intermediate trusted via NODE_EXTRA_CA_CERTS (merged with any value you
// already have). TLS verification stays fully on.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = dirname(fileURLToPath(import.meta.url));
const cert = join(root, 'certs', 'godaddy-g2-intermediate.pem');

if (process.env.CAD_MONITOR_CHILD) {
  await import('./src/node-server.js');
} else {
  let caFile = cert;
  const existing = process.env.NODE_EXTRA_CA_CERTS;
  if (existing && existing !== cert) {
    try {
      caFile = join(tmpdir(), 'scpa-cad-monitor-ca.pem');
      writeFileSync(caFile, readFileSync(existing, 'utf8') + '\n' + readFileSync(cert, 'utf8'));
    } catch { caFile = cert; }
  }
  const child = spawn(process.execPath, [join(root, 'src', 'node-server.js')], {
    stdio: 'inherit', env: { ...process.env, NODE_EXTRA_CA_CERTS: caFile, CAD_MONITOR_CHILD: '1' },
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code) => process.exit(code ?? 0));
}
