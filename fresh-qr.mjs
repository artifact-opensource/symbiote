import makeWASocket from '@whiskeysockets/baileys';
import { useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';

const AUTH_DIR = path.join(process.env.HOME || '/home/adam', '.symbiote/credentials/whatsapp/default');
const QR_HTML_PATH = path.join(process.env.HOME || '/home/adam', 'whatsapp-qr.html');

async function main() {
    console.log('� Fresh WhatsApp QR Generator\n');
    
    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, auth: state });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async ({ qr, connection }) => {
        if (qr) {
            console.log('📱 Fresh QR generated:\n' + qr + '\n');
            const html = `<!DOCTYPE html><html><head><title>WhatsApp QR</title></head><body style="display:flex;align-items:center;justify-content:center;height:100vh;background:#f0f0f0"><div style="text-align:center"><h1>📱 Scan to Link WhatsApp</h1><img src="${await QRCode.toDataURL(qr)}" style="max-width:500px;border:2px solid #333"/><p>Linked Devices → Link a Device</p></div></body></html>`;
            fs.writeFileSync(QR_HTML_PATH, html);
            console.log(`✅ Saved: ${QR_HTML_PATH}\n`);
        }
        if (connection === 'open') {
            console.log('✅ Connected!\n');
            process.exit(0);
        }
    });
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
