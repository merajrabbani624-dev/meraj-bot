const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  makeCacheableSignalKeyStore,
  delay
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');

// ==================== CONFIGURATION ====================
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const AUTH_FOLDER = './auth_info';

// Fallback version to prevent 405 Errors
const FALLBACK_WA_VERSION = [2, 3000, 1015901307];

// ==================== STATE ====================
let sock = null;
let qrDataURL = null;
let connectionStatus = 'Disconnected';

// ==================== SERVER ====================
const app = express();

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>Meraj Bot</title><meta http-equiv="refresh" content="10"></head>
      <body style="font-family:sans-serif; text-align:center; padding:50px;">
        <h1>🤖 Meraj Bot is Active</h1>
        <p>Status: <strong>${connectionStatus}</strong></p>
        ${connectionStatus !== 'Connected' ? '<a href="/qr">Scan QR Code</a>' : '✅ System Normal'}
      </body>
    </html>
  `);
});

app.get('/qr', (req, res) => {
  if (qrDataURL && connectionStatus !== 'Connected') {
    res.send(`<div style="text-align:center;"><img src="${qrDataURL}" style="border:5px solid green; width:300px;" /></div>`);
  } else {
    res.send('<h2>Bot is already connected or reloading...</h2>');
  }
});

// ==================== CORE LOGIC ====================

async function getVersion() {
  try {
    const { version } = await fetchLatestBaileysVersion();
    return version;
  } catch {
    return FALLBACK_WA_VERSION;
  }
}

async function connectToWhatsApp() {
  // 1. Ensure Auth Folder Exists
  if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const version = await getVersion();
  
  // 2. Strict Silent Logger to prevent "SessionEntry" spam
  const logger = pino({ level: 'fatal' });

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    logger: logger,
    browser: Browsers.ubuntu('Chrome'),
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 2000,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('✨ New QR Code generated.');
      qrDataURL = await QRCode.toDataURL(qr);
      connectionStatus = 'Scan QR';
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`⚠️ Connection closed. Reason: ${reason}`);
      connectionStatus = 'Disconnected';
      qrDataURL = null;

      // CRITICAL: Only delete session if TRULY Logged Out (401)
      if (reason === DisconnectReason.loggedOut) {
        console.log('❌ Device Logged Out. Clearing session...');
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        connectToWhatsApp();
      } else {
        // For 515, 405, 408, 500 -> Just Reconnect. Do NOT delete session.
        console.log('🔄 Network glitch. Reconnecting in 3s...');
        setTimeout(connectToWhatsApp, 3000);
      }
    } else if (connection === 'open') {
      console.log('✅ Connected to WhatsApp!');
      connectionStatus = 'Connected';
      qrDataURL = null;
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // --- MESSAGES ---
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;
    
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    const from = msg.key.remoteJid;

    if (!text) return;

    if (text.toLowerCase() === '.ping') {
      await sock.sendMessage(from, { text: '🏓 Pong!' }, { quoted: msg });
    }
    
    // AI COMMAND - Switched to 'gemini-flash-latest' as requested
    else if (text.toLowerCase().startsWith('.ask ')) {
      if (!API_KEY) return sock.sendMessage(from, { text: '❌ No API_KEY found.' });
      
      const query = text.slice(5).trim();
      try {
        const genAI = new GoogleGenerativeAI(API_KEY);
        // CHANGED: Using the classic 'gemini-pro' model
        const model = genAI.getGenerativeModel({ model: 'gemini-pro' });
        const result = await model.generateContent(query);
        const response = result.response.text();
        await sock.sendMessage(from, { text: response }, { quoted: msg });
      } catch (err) {
        console.error("AI Error:", err.message); // Print minimal error
        await sock.sendMessage(from, { text: 'AI Error: ' + err.message }, { quoted: msg });
      }
    }
  });
}

// Start
app.listen(PORT, () => console.log(`🌍 Server on port ${PORT}`));
connectToWhatsApp();

