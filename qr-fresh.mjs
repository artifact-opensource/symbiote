import makeWASocket from '@whiskeysockets/baileys';
import { useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode-terminal';
import path from 'path';
import fs from 'fs';

const AUTH_DIR = path.join(process.env.HOME || '/home/adam', '.symbiote/credentials/whatsapp/default');

async function main() {
    console.log('\n📱 WhatsApp QR — Fresh Scan\n');
    console.log('─'.repeat(60));
    
    // Ensure dir exists
    if (!fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        console.log(`Created: ${AUTH_DIR}\n`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, auth: state, printQRInTerminal: false });

    let credsSaved = false;
    let connectionOpen = false;
    
    sock.ev.on('creds.update', () => {
        credsSaved = true;
        console.log('✅ Credentials saved');
        saveCreds();
    });
    
    sock.ev.on('connection.update', ({ qr, connection, lastDisconnect }) => {
        if (qr) {
            console.clear();
            console.log('\n📱 Scan with Your Phone\n');
            console.log('WhatsApp → Settings → Linked Devices → Link a Device\n');
            QRCode.generate(qr, { small: true, type: 'terminal' });
            console.log('\nWaiting...\n');
        }
        
        if (connection === 'connecting') {
            console.log('🔄 Connecting...');
        }
        
        if (connection === 'open') {
            connectionOpen = true;
            if (credsSaved) {
                console.log('\n✅ CONNECTED & AUTHENTICATED!\n');
                process.exit(0);
            } else {
                console.log('⏳ Authenticating...');
            }
        }
        
        if (connection === 'close') {
            const shouldRetry = lastDisconnect?.error?.output?.statusCode !== 401;
            console.log(`⚠️  Disconnected (code: ${lastDisconnect?.error?.output?.statusCode})`);
            if (shouldRetry) {
                console.log('Reconnecting...\n');
            } else {
                console.log('Authentication failed. Try scanning again.\n');
                process.exit(1);
            }
        }
    });
    
    // Timeout after 2 minutes
    setTimeout(() => {
        console.log('\n⏱️  QR expired. Restart the script for a fresh QR.\n');
        process.exit(1);
    }, 120000);
}

main().catch(err => { 
    console.error('❌ Error:', err.message); 
    process.exit(1); 
});
