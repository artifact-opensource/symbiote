import fs from 'fs';
import path from 'path';
import qrcode from 'qrcode';

const LOG = '/opt/ava/mach6/symbiote.log';
const OUT_PNG = path.join(process.env.HOME || '/home/adam', 'whatsapp-qr.png');
const OUT_HTML = path.join(process.env.HOME || '/home/adam', 'whatsapp-qr.html');

function extractQr(log) {
  const idx = log.lastIndexOf('QR Data:');
  if (idx === -1) return null;
  const after = log.slice(idx + 'QR Data:'.length);
  const lines = after.split(/\r?\n/);
  const qrLines = [];
  for (const l of lines) {
    if (l.trim() === '') break;
    qrLines.push(l.trim());
  }
  return qrLines.join('').trim();
}

(async () => {
  if (!fs.existsSync(LOG)) {
    console.error('Log not found:', LOG);
    process.exit(2);
  }

  const log = fs.readFileSync(LOG, 'utf8');
  const qr = extractQr(log);
  if (!qr) {
    console.error('No QR Data found in log.');
    process.exit(3);
  }

  try {
    const dataUrl = await qrcode.toDataURL(qr, { width: 400 });
    const base64 = dataUrl.split(',')[1];
    fs.writeFileSync(OUT_PNG, Buffer.from(base64, 'base64'));

    const html = `<!doctype html><meta charset="utf-8"><title>WhatsApp QR</title><style>body{display:flex;align-items:center;justify-content:center;height:100vh;background:#111;color:#fff}img{max-width:90vw;height:auto;border:6px solid #222;background:#fff;padding:12px;border-radius:6px}</style><div><h2>Scan with WhatsApp → Linked Devices → Link a Device</h2><img src="${dataUrl}" alt="WhatsApp QR"/></div>`;
    fs.writeFileSync(OUT_HTML, html);

    console.log('Wrote:', OUT_PNG);
    console.log('Also: ', OUT_HTML);
    process.exit(0);
  } catch (err) {
    console.error('Failed to generate QR PNG:', err && err.message);
    process.exit(1);
  }
})();
