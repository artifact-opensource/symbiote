/**
 * AVA WhatsApp QR Launcher
 * Run: node whatsapp-qr-launcher.mjs
 * Scan with WhatsApp → Linked Devices → Link a Device
 */

import makeWASocket from '@whiskeysockets/baileys';
import { useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(process.env.HOME || '/home/adam', '.symbiote/credentials/whatsapp/default');
const QR_HTML_PATH = path.join(process.env.HOME || '/home/adam', 'whatsapp-qr.html');

async function main() {
    console.log('\n� AVA WhatsApp QR Launcher');
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

    sock.ev.on('connection.update', async ({ qr, connection }) => {
        if (qr) {
            console.log('📱 NEW QR CODE GENERATED\n');
            console.log('📱 Scan with WhatsApp → Linked Devices → Link a Device\n');
            console.log('QR Data URL:\n' + qr + '\n');
            
            // Generate and save as HTML
            try {
                const qrDataUrl = await QRCode.toDataURL(qr);
                const html = `<!DOCTYPE html>
<html>
<head><title>WhatsApp QR Code</title></head>
<body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f0f0">
  <div style="text-align:center">
    <h1>📱 Scan to Link WhatsApp</h1>
    <img src="${qrDataUrl}" style="max-width:500px;border:2px solid #333" />
    <p>Scan with WhatsApp → Linked Devices → Link a Device</p>
  </div>
</body>
</html>`;
                fs.writeFileSync(QR_HTML_PATH, html);
                console.log(`✅ QR saved to: ${QR_HTML_PATH}\n`);
            } catch (e) {
                console.log('⚠️ Could not save HTML:', e.message);
            }
        }
        if (connection === 'open') {
            console.log('\n✅ WhatsApp connected! Credentials saved.\n');
            console.log('You can now close this terminal and restart the gateway.');
            process.exit(0);
        }
        if (connection === 'close') {
            console.log('Connection closed — reconnecting...\n');
        }
    });
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
