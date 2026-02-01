const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const QRCode = require('qrcode');
const express = require('express');
const fs = require('fs');
const pino = require('pino');

// --- CONFIGURATION ---
const API_KEY = process.env.API_KEY; 

// --- SERVER & WEB QR SYSTEM ---
const app = express();
const PORT = process.env.PORT || 3000;
let currentQR = null;

app.get('/', (req, res) => {
    res.send(`
        <div style="font-family:sans-serif; text-align:center; padding:50px;">
            <h1>Meraj Bot Status: <span style="color:green;">Online 🟢</span></h1>
            <p><a href="/qr" style="font-size:20px; color:blue;">Click here to Scan QR Code</a></p>
        </div>
    `);
});

app.get('/qr', (req, res) => {
    if (currentQR) {
        res.send(`
            <html>
                <body style="display:flex; justify-content:center; align-items:center; height:100vh; background:#222; color:white; font-family:sans-serif;">
                    <div style="text-align:center;">
                        <h2>Scan with WhatsApp</h2>
                        <img src="${currentQR}" style="border:10px solid white; border-radius:10px; width:300px; height:300px;" />
                        <p style="margin-top:20px;">Settings > Linked Devices > Link a Device</p>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send('<h2 style="font-family:sans-serif; text-align:center; margin-top:50px;">✅ Bot is already connected! No QR needed.</h2>');
    }
});

app.listen(PORT, () => console.log(`🌍 Server active on port ${PORT}`));

const SYSTEM_PROMPT = `You are Meraj AI. Keep answers short. No LaTeX.`;

async function start() {
    console.log("🚀 Starting Bot (Fixed Version Mode)...");

    // 1. HARD WIPE to fix 405 Loop
    if (fs.existsSync('auth_info')) {
        console.log("♻️  Cleaning session...");
        fs.rmSync('auth_info', { recursive: true, force: true });
    }
    fs.mkdirSync('auth_info');
    
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    // 2. HARDCODED VERSION (Crucial Fix)
    // This stops the bot from asking WhatsApp server for the version (which was failing)
    const version = [2, 3000, 1015901307];

    const sock = makeWASocket({
        version, // <--- This line prevents the 405 Error
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: Browsers.ubuntu('Chrome'), 
        syncFullHistory: false,
        connectTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("✨ QR Code generated! Open the website URL to scan.");
            currentQR = await QRCode.toDataURL(qr);
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Connection closed. Reason: ${reason}`);
            
            // If logged out or 405, we restart completely
            if (reason === DisconnectReason.loggedOut || reason === 405) {
                console.log("❌ Critical Error. Restarting...");
                start();
            } else {
                setTimeout(start, 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ SUCCESS! Bot is Connected.');
            currentQR = null;
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
