import makeWASocket from '@whiskeysockets/baileys';
import { useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode-terminal';
import path from 'path';
import fs from 'fs';

const AUTH_DIR = path.join(process.env.HOME || '/home/adam', '.symbiote/credentials/whatsapp/default');

async function main() {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, auth: state });

    sock.ev.on('creds.update', saveCreds);
    
    let qrShown = false;
    
    sock.ev.on('connection.update', ({ qr, connection }) => {
        if (qr && !qrShown) {
            console.clear();
            console.log('\n📱 WhatsApp QR Code — Scan with Your Phone\n');
            console.log('Tap: Settings → Linked Devices → Link a Device\n');
            QRCode.generate(qr, { small: true, type: 'terminal' });
            console.log('\nWaiting for scan...\n');
            qrShown = true;
        }
        if (connection === 'open') {
            console.log('\n✅ Connected!\n');
            process.exit(0);
        }
        if (connection === 'close') {
            qrShown = false;
        }
    });
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
