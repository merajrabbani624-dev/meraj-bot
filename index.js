const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const QRCode = require('qrcode'); // Library for Web QR
const express = require('express');
const fs = require('fs');
const pino = require('pino');

// --- CONFIGURATION ---
const API_KEY = process.env.API_KEY; 
const OWNER_NUMBER = "917001747616@s.whatsapp.net";

// --- SERVER & WEB QR SYSTEM ---
const app = express();
const PORT = process.env.PORT || 3000;
let currentQR = null; // Variable to store the QR code

// 1. Home Page
app.get('/', (req, res) => {
    res.send('<h1>Meraj Bot is Active 🤖</h1><p><a href="/qr">Click here to Scan QR</a></p>');
});

// 2. The QR Page (This solves the distortion issue)
app.get('/qr', (req, res) => {
    if (currentQR) {
        // Display the QR as a large image
        res.send(`
            <html>
                <body style="display:flex; justify-content:center; align-items:center; height:100vh; background:#f0f0f0;">
                    <div style="text-align:center;">
                        <h2>Scan this code on WhatsApp</h2>
                        <img src="${currentQR}" style="border:5px solid white; border-radius:10px; box-shadow:0 0 10px rgba(0,0,0,0.1);" />
                        <p>Settings > Linked Devices > Link a Device</p>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send('<h2>✅ Bot is already connected! No QR needed.</h2>');
    }
});

app.listen(PORT, () => console.log(`🌍 Server active on port ${PORT}`));

// --- AI CONFIG ---
const SYSTEM_PROMPT = `You are Meraj AI. Keep answers short. No LaTeX.`;

async function start() {
    console.log("🚀 Starting Bot (Web QR Mode)...");

    if (!fs.existsSync('auth_info')) fs.mkdirSync('auth_info');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // We use the website instead
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu('Chrome'), 
        syncFullHistory: false,
        connectTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // --- GENERATE WEB QR ---
        if (qr) {
            console.log("✨ QR Code generated! Check the website.");
            // Convert QR text to a Scan-able Image Data URL
            currentQR = await QRCode.toDataURL(qr);
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Connection closed. Reason: ${reason}`);
            
            if (reason === DisconnectReason.loggedOut) {
                console.log("❌ Logged out. Clearing session.");
                fs.rmSync('auth_info', { recursive: true, force: true });
                currentQR = null; // Reset QR
                start();
            } else {
                setTimeout(start, 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ SUCCESS! Bot is Connected.');
            currentQR = null; // Remove QR once connected
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
