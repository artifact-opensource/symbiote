/**
 * AVA WhatsApp QR Launcher
 * Run in foreground terminal: node whatsapp-qr-launcher.js
 * Scan with WhatsApp → Linked Devices → Link a Device
 */

const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

const AUTH_DIR = path.join(process.env.HOME || '/home/adam', '.mach6/credentials/whatsapp/default');

async function main() {
    console.log('\n🔮 AVA WhatsApp QR Launcher');
    console.log('============================');
    console.log(`Auth dir: ${AUTH_DIR}\n`);

    // Ensure auth directory exists
    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`Baileys v${version.join('.')} connecting...\n`);

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false, // We handle it manually for better control
        logger: { level: 'warn' },
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ qr, connection }) => {
        if (qr) {
            console.log('\n📱 SCAN THIS QR CODE WITH WHATSAPP:\n');
            QRCode.generate(qr, { small: false });
            console.log('\nWaiting for scan...\n');
        }
        if (connection === 'open') {
            console.log('\n✅ WhatsApp connected successfully!\n');
            process.exit(0);
        }
        if (connection === 'close') {
            console.log('\n❌ Connection closed. Restarting...\n');
        }
    });
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
