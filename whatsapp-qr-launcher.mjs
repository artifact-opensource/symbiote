/**
 * AVA WhatsApp QR Launcher
 * Run: node whatsapp-qr-launcher.mjs
 * Scan with WhatsApp → Linked Devices → Link a Device
 */

import makeWASocket from '@whiskeysockets/baileys';
import { useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode-terminal';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(process.env.HOME || '/home/adam', '.mach6/credentials/whatsapp/default');

async function main() {
    console.log('\n🔮 AVA WhatsApp QR Launcher');
    console.log('============================');
    console.log(`Auth dir: ${AUTH_DIR}\n`);

    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`Baileys v${version.join('.')} connecting...\n`);

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ qr, connection }) => {
        if (qr) {
            console.clear();
            console.log('\n📱 SCAN THIS QR CODE WITH WHATSAPP:\n');
            QRCode.generate(qr, { small: false });
            console.log('\nWaiting for scan...\n');
        }
        if (connection === 'open') {
            console.log('\n✅ WhatsApp connected! Credentials saved.\n');
            console.log('You can now close this terminal and restart the gateway.');
            process.exit(0);
        }
        if (connection === 'close') {
            console.log('Connection closed — will reconnect...\n');
        }
    });
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
