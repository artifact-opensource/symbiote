import makeWASocket from '@whiskeysockets/baileys';
import { useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import path from 'path';
import fs from 'fs';

const AUTH_DIR = path.join(process.env.HOME || '/home/adam', '.symbiote/credentials/whatsapp/default');

async function main() {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, auth: state });

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', ({ qr, connection }) => {
        if (qr) {
            console.clear();
            console.log('\n✅ NEW QR GENERATED\n');
            console.log('📱 Open WhatsApp on your phone → Linked Devices → Link a Device\n');
            console.log('Scan this URL as QR code:\n');
            console.log(qr + '\n');
            console.log('─'.repeat(80));
            console.log('\nWaiting for scan...\n');
        }
        if (connection === 'open') {
            console.log('\n✅ CONNECTED!\n');
            process.exit(0);
        }
    });
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
