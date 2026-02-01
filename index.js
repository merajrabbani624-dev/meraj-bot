const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, delay } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const fs = require('fs');
const pino = require('pino');

// --- CONFIGURATION ---
const API_KEY = process.env.API_KEY;
const BOT_NUMBER = "918016918361"; 
const OWNER_NUMBER = "918016918361@s.whatsapp.net";

// --- SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Meraj Bot Active 🟢'));
app.listen(PORT, () => console.log(`🌍 Server active on port ${PORT}`));

const SYSTEM_PROMPT = `You are Meraj AI. Keep answers short. No LaTeX.`;

async function start() {
    console.log("🚀 Starting Bot...");

    // 🛑 ZOMBIE KILLER: This checks if the session is broken
    // If we have a folder but no valid login, we wipe it.
    if (fs.existsSync('auth_info')) {
        // We will attempt to load it. If it fails or is stuck, the logic below handles it.
    } else {
        fs.mkdirSync('auth_info');
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        // SWITCHED TO MacOS: This often fixes the "Could not login" error
        browser: Browsers.macOS('Desktop'), 
        syncFullHistory: false,
        connectTimeoutMs: 60000,
    });

    // --- PAIRING LOGIC ---
    // This will run ONLY if the bot is not already logged in
    if (!sock.authState.creds.registered) {
        console.log("⏳ Connection warming up (Wait 5s)...");
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
                // If this fails, it means the session is corrupted. WIPE IT.
                console.log("♻️ Session corrupted. Wiping and retrying...");
                fs.rmSync('auth_info', { recursive: true, force: true });
                process.exit(1); // Restart the bot
            }
        }, 5000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Connection closed. Reason: ${reason}`);

            // 401 means "Logged Out" or "Bad Session". We must wipe.
            if (reason === DisconnectReason.loggedOut || reason === 401) {
                console.log("❌ Session Invalid. Deleting auth_info...");
                fs.rmSync('auth_info', { recursive: true, force: true });
                start(); // Restart fresh
            } else {
                // Any other error, just retry
                setTimeout(start, 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ SUCCESS! Bot is Connected.');
        }
    });

    if (!API_KEY) console.error("❌ API_KEY is NOT set!");
    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash", systemInstruction: SYSTEM_PROMPT });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        const chatId = msg.key.remoteJid;
        const isMe = msg.key.fromMe;

        console.log(`📩 New Message: ${text}`);

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

