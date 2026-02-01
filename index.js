const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, delay } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const fs = require('fs');
const pino = require('pino');

// --- CONFIGURATION ---
const API_KEY = process.env.API_KEY;
// ⚠️ Your Phone Number (No '+' sign)
const BOT_NUMBER = "917001747616"; 
const OWNER_NUMBER = "917001747616@s.whatsapp.net";

// --- KEEP-ALIVE SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Meraj Bot (Pairing Mode) 🟢');
});

app.listen(PORT, () => {
    console.log(`🌍 Server active on port ${PORT}`);
});

// --- AI CONFIG ---
const SYSTEM_PROMPT = `
You are Meraj AI.
1. NO LaTeX.
2. MATH: Use Unicode (∫, x², √x).
3. BOLD: Use *bold* for answers.
`;

async function start() {
    console.log("🚀 Starting Pairing Mode...");

    if (!fs.existsSync('auth_info')) fs.mkdirSync('auth_info');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    // --- RENDER CONNECTION ---
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // QR OFF
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu('Chrome'), // Linux Signature
        syncFullHistory: false,
        connectTimeoutMs: 60000,
    });

    // --- PAIRING CODE LOGIC ---
    if (!sock.authState.creds.registered) {
        console.log("⏳ Waiting for connection to stabilize...");
        
        // Wait 3 seconds, then request the code
        setTimeout(async () => {
            try {
                console.log("📡 Requesting Pairing Code...");
                const code = await sock.requestPairingCode(BOT_NUMBER);
                console.log("\n\n====================================================");
                console.log("✨ YOUR PAIRING CODE:");
                console.log(`\x1b[32m${code?.match(/.{1,4}/g)?.join("-") || code}\x1b[0m`);
                console.log("====================================================\n\n");
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
                console.log("⏳ Reconnecting...");
                setTimeout(start, 3000);
            } else {
                console.log("❌ Logged out. Clearing session.");
                fs.rmSync('auth_info', { recursive: true, force: true });
                start();
            }
        } else if (connection === 'open') {
            console.log('✅ SUCCESS! Bot is Connected.');
        }
    });

    if (!API_KEY) return console.error("❌ API_KEY missing!");
    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", systemInstruction: SYSTEM_PROMPT });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        const chatId = msg.key.remoteJid;

        if (text.toLowerCase() === '.ping') {
             await sock.sendMessage(chatId, { text: "🏓 Pong!" }, { quoted: msg });
        }

        if (text.toLowerCase().startsWith('.ask ')) {
            const query = text.slice(5).trim();
            const chat = model.startChat({});
            try {
                const result = await chat.sendMessage(query);
                await sock.sendMessage(chatId, { text: result.response.text() }, { quoted: msg });
            } catch (err) {
                await sock.sendMessage(chatId, { text: "Error: " + err.message }, { quoted: msg });
            }
        }
    });
}
start();
