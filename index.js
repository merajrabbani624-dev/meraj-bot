const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, delay } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const fs = require('fs');
const pino = require('pino');

// --- CONFIGURATION ---
const API_KEY = process.env.API_KEY;
const BOT_NUMBER = "917001747616"; 
const OWNER_NUMBER = "917001747616@s.whatsapp.net";

// --- SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Meraj Bot Active 🟢'));
app.listen(PORT, () => console.log(`🌍 Server active on port ${PORT}`));

// --- AI CONFIG ---
const SYSTEM_PROMPT = `
You are Meraj AI.
1. NO LaTeX.
2. MATH: Use Unicode (∫, x², √x).
3. BOLD: Use *bold* for answers.
`;

async function start() {
    console.log("🚀 Starting Bot...");

    if (!fs.existsSync('auth_info')) fs.mkdirSync('auth_info');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false, // Ignores old messages to start faster
        connectTimeoutMs: 60000,
    });

    // Pairing Logic
    if (!sock.authState.creds.registered) {
        console.log("⏳ Waiting for connection...");
        setTimeout(async () => {
            try {
                console.log("📡 Requesting Pairing Code...");
                const code = await sock.requestPairingCode(BOT_NUMBER);
                console.log(`✨ PAIRING CODE: ${code}`);
            } catch (err) {
                console.log("❌ Error requesting code: " + err.message);
            }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Connection closed. Reason: ${reason}`);
            if (reason !== DisconnectReason.loggedOut) {
                setTimeout(start, 3000);
            } else {
                console.log("❌ Logged out. Clearing session.");
                fs.rmSync('auth_info', { recursive: true, force: true });
                start();
            }
        } else if (connection === 'open') {
            console.log('✅ SUCCESS! Bot is Connected & Listening.');
        }
    });

    if (!API_KEY) return console.error("❌ API_KEY missing!");
    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", systemInstruction: SYSTEM_PROMPT });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        // --- EXTRACT TEXT SAFELY ---
        // This handles text, image captions, and quoted text
        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || 
                     msg.message.imageMessage?.caption || "";
        
        const chatId = msg.key.remoteJid;

        // --- DEBUG LOGGING ---
        // This will show up in Render Logs!
        console.log(`📩 Received from ${chatId.split('@')[0]}: ${text}`);

        // --- COMMANDS ---
        if (text.toLowerCase() === '.ping') {
             console.log("🏓 Sending Pong...");
             await sock.sendMessage(chatId, { text: "🏓 Pong!" }, { quoted: msg });
        }

        if (text.toLowerCase().startsWith('.ask ')) {
            const query = text.slice(5).trim();
            console.log(`🧠 AI Query: ${query}`);
            const chat = model.startChat({});
            try {
                const result = await chat.sendMessage(query);
                await sock.sendMessage(chatId, { text: result.response.text() }, { quoted: msg });
            } catch (err) {
                console.error("AI Error:", err);
                await sock.sendMessage(chatId, { text: "Error: " + err.message }, { quoted: msg });
            }
        }
    });
}
start();
