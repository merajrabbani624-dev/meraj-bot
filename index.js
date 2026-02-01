const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const qrcode = require('qrcode-terminal');
const express = require('express');
const fs = require('fs');
const pino = require('pino');

// --- CONFIGURATION ---
const API_KEY = process.env.API_KEY; 
const OWNER_NUMBER = "917001747616@s.whatsapp.net";

// --- KEEP-ALIVE SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Meraj Bot is Running 🟢');
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
    console.log("🚀 Starting Bot...");

    // Create auth folder
    if (!fs.existsSync('auth_info')) fs.mkdirSync('auth_info');
    
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    // --- RENDER-OPTIMIZED CONNECTION ---
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // <--- FIXED: Set to false to stop warnings
        logger: pino({ level: "silent" }),
        // Use Ubuntu signature to look like a standard Linux server
        browser: Browsers.ubuntu('Chrome'), 
        syncFullHistory: false,
        connectTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // --- MANUAL QR GENERATION ---
        if (qr) {
            console.log("\n✨ SCAN THE QR CODE BELOW:\n");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Connection closed. Reason: ${reason}`);
            
            // If 405 or 408 (Server errors), we wipe and restart
            if (reason === 405 || reason === 408) {
                console.log("❌ Server rejected connection. Clearing session and retrying...");
                fs.rmSync('auth_info', { recursive: true, force: true });
                start();
            } else if (reason !== DisconnectReason.loggedOut) {
                console.log("⏳ Reconnecting...");
                setTimeout(start, 3000);
            } else {
                console.log("❌ Logged out. Delete auth_info manually.");
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
