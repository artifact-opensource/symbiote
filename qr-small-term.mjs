import makeWASocket from '@whiskeysockets/baileys';
import { useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import path from 'path';
import fs from 'fs';

const AUTH_DIR = path.join(process.env.HOME || '/home/adam', '.mach6/credentials/whatsapp/default');

async function main() {
  console.log('\n📱 Compact WhatsApp QR — Scan with Phone Camera\n');

  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state });

  sock.ev.on('creds.update', saveCreds);

  let shown = false;
  sock.ev.on('connection.update', ({ qr, connection }) => {
    if (qr && !shown) {
      console.clear();
      console.log('\n📱 NEW COMPACT QR — Open WhatsApp → Linked Devices → Link a Device\n');
      qrcode.generate(qr, { small: true });
      console.log('\nWaiting for scan...');
      shown = true;
    }
    if (connection === 'open') {
      console.log('\n✅ WhatsApp connected — credentials saved to:', AUTH_DIR, '\n');
      process.exit(0);
    }
    if (connection === 'close') {
      console.log('\n⚠️ Connection closed — regenerating QR...\n');
      shown = false;
    }
  });
}

main().catch(err => { console.error('Error:', err && err.message); process.exit(1); });
