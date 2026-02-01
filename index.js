const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ==================== CONFIGURATION ====================
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const AUTH_FOLDER = './auth_info';

// Hardcoded fallback WhatsApp version (CRITICAL FIX for Cloud Hosting)
// This prevents the bot from crashing if the version check fails
const FALLBACK_WA_VERSION = [2, 3000, 1015901307];

// ==================== GLOBAL STATE ====================
let sock = null;
let qrDataURL = null;
let connectionStatus = 'Disconnected';

// ==================== EXPRESS SERVER ====================
const app = express();

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WhatsApp Bot Status</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; background: #f0f2f5; }
        .container { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; }
        h1 { color: #25D366; }
        .status { padding: 15px; border-radius: 8px; margin: 20px 0; font-weight: bold; }
        .status.connected { background: #d4edda; color: #155724; }
        .status.disconnected { background: #f8d7da; color: #721c24; }
        .btn { display: inline-block; padding: 12px 30px; background: #25D366; color: white; text-decoration: none; border-radius: 6px; margin: 10px; }
        .btn:hover { background: #128C7E; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🤖 WhatsApp Bot Dashboard</h1>
        <div class="status ${connectionStatus === 'Connected' ? 'connected' : 'disconnected'}">
          Status: ${connectionStatus}
        </div>
        <p><strong>Commands:</strong> .ping, .ask [question]</p>
        <a href="/qr" class="btn">📱 Scan QR Code</a>
        <a href="/restart" class="btn" style="background: #ff6b6b;">🔄 Force Restart</a>
      </div>
    </body>
    </html>
  `);
});

app.get('/qr', (req, res) => {
  if (qrDataURL && connectionStatus !== 'Connected') {
    res.send(`
      <html>
        <body style="display:flex; justify-content:center; align-items:center; height:100vh; background:#222;">
          <div style="text-align:center; background:white; padding:20px; border-radius:10px;">
            <h2 style="color:#25D366;">Scan with WhatsApp</h2>
            <img src="${qrDataURL}" style="border:5px solid #25D366; border-radius:10px; width:300px;" />
            <p>Settings > Linked Devices > Link a Device</p>
          </div>
        </body>
      </html>
    `);
  } else {
    res.send('<h2 style="text-align:center; margin-top:50px;">✅ Bot is connected or QR not ready yet. <br> <a href="/">Go Back</a></h2>');
  }
});

app.get('/restart', async (req, res) => {
  res.send('<h2>🔄 Restarting bot and clearing session...</h2><script>setTimeout(() => window.location.href="/", 5000)</script>');
  await deleteAuthFolder();
  process.exit(0); // This forces the cloud platform to restart the bot
});

// ==================== HELPER FUNCTIONS ====================

async function deleteAuthFolder() {
  try {
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      console.log('✅ Auth folder deleted successfully');
    }
  } catch (error) {
    console.error('❌ Error deleting auth folder:', error);
  }
}

async function getBaileysVersion() {
  try {
    console.log('🔍 Fetching latest WhatsApp version...');
    const { version } = await fetchLatestBaileysVersion();
    console.log(`✅ Fetched version: ${version.join('.')}`);
    return version;
  } catch (error) {
    console.warn('⚠️ Network failed. Using HARDCODED Fallback version.');
    return FALLBACK_WA_VERSION;
  }
}

// ==================== AI SETUP ====================
let model = null;
if (API_KEY) {
  try {
    const genAI = new GoogleGenerativeAI(API_KEY);
    model = genAI.getGenerativeModel({
      model: 'gemini-flash-preview',
      systemInstruction: `You are a WhatsApp assistant. No LaTeX. Use Unicode for math.`
    });
    console.log('✅ Gemini AI initialized');
  } catch (err) {
    console.error('❌ AI Init Failed:', err.message);
  }
}

// ==================== WHATSAPP CONNECTION ====================

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const version = await getBaileysVersion();

  sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'), // Ubuntu signature reduces bans
    connectTimeoutMs: 60000,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('✨ QR Code generated. Check /qr route.');
      qrDataURL = await QRCode.toDataURL(qr);
      connectionStatus = 'Scan QR Code';
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log(`⚠️ Connection closed. Code: ${statusCode}`);
      connectionStatus = 'Disconnected';
      qrDataURL = null;

      // FIX: If 405 (Method Not Allowed) or 401 (Logged Out), WIPE SESSION
      if (statusCode === 405 || statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
        console.log('🛑 Critical Error (405/401). Deleting session and restarting...');
        await deleteAuthFolder();
        setTimeout(connectToWhatsApp, 2000);
      } else {
        setTimeout(connectToWhatsApp, 3000);
      }
    } else if (connection === 'open') {
      console.log('✅ Connected to WhatsApp!');
      connectionStatus = 'Connected';
      qrDataURL = null;
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;

    const from = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';

    if (!text) return;
    console.log(`📩 New Message: ${text}`);

    // Command: .ping
    if (text.toLowerCase() === '.ping') {
      await sock.sendMessage(from, { text: '🏓 Pong!' }, { quoted: msg });
    }

    // Command: .ask
    else if (text.toLowerCase().startsWith('.ask ')) {
      const query = text.slice(5).trim();
      if (!model) return sock.sendMessage(from, { text: '❌ AI API Key not set.' });

      await sock.sendMessage(from, { react: { text: "🤔", key: msg.key } });
      try {
        const result = await model.generateContent(query);
        await sock.sendMessage(from, { text: result.response.text() }, { quoted: msg });
      } catch (err) {
        await sock.sendMessage(from, { text: '❌ Error: ' + err.message }, { quoted: msg });
      }
    }
  });
}

// ==================== START ====================
app.listen(PORT, () => console.log(`🌍 Server running on port ${PORT}`));
connectToWhatsApp();

