const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const QRCode = require('qrcode');
const express = require('express');
const fs = require('fs');
const pino = require('pino');

// --- CONFIGURATION ---
const API_KEY = process.env.API_KEY; 
const OWNER_NUMBER = "917001747616@s.whatsapp.net";

// --- SERVER & WEB QR SYSTEM ---
const app = express();
const PORT = process.env.PORT || 3000;
let currentQR = null; // Stores the QR Code image data

// 1. Status Page
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family:sans-serif; text-align:center; padding:50px;">
            <h1>Meraj Bot Status: <span style="color:green;">Online 🟢</span></h1>
            <p><a href="/qr" style="font-size:20px; color:blue;">Click here to Scan QR Code</a></p>
        </div>
    `);
});

// 2. The QR Display Page
app.get('/qr', (req, res) => {
    if (currentQR) {
        res.send(`
            <html>
                <body style="display:flex; justify-content:center; align-items:center; height:100vh; background:#222; color:white; font-family:sans-serif;">
                    <div style="text-align:center;">
                        <h2>Scan with WhatsApp</h2>
                        <img src="${currentQR}" style="border:10px solid white; border-radius:10px; width:300px; height:300px;" />
                        <p style="margin-top:20px;">Settings > Linked Devices > Link a Device</p>
                        <p style="color:yellow;">If it doesn't scan, zoom out (Ctrl -)</p>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send('<h2 style="font-family:sans-serif; text-align:center; margin-top:50px;">✅ Bot is already connected! No QR needed.</h2>');
    }
});

app.listen(PORT, () => console.log(`🌍 Server active on port ${PORT}`));

// --- AI CONFIG ---
const SYSTEM_PROMPT = `You are Meraj AI. Keep answers short. No LaTeX.`;

async function start() {
    console.log("🚀 Starting Bot (Web QR Mode)...");

    // --- 🛑 THE 405 FIX: HARD WIPE ---
    // If the folder exists, we delete it to kill the "Zombie Session" causing 405 errors.
    if (fs.existsSync('auth_info')) {
        console.log("♻️  Fixing 405 Error: Wiping corrupted session...");
        fs.rmSync('auth_info', { recursive: true, force: true });
    }
    
    fs.mkdirSync('auth_info');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // We use the website
        logger: pino({ level: "silent" }),
        // FIX: Switch to macOS signature which is more stable on Render
        browser: Browsers.macOS('Desktop'), 
        syncFullHistory: false,
        connectTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // --- GENERATE WEB QR ---
        if (qr) {
            console.log("✨ QR Code generated! Open the website URL to scan.");
            // Convert QR to Image
            currentQR = await QRCode.toDataURL(qr);
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Connection closed. Reason: ${reason}`);
            
            // If logged out or 405, we restart to wipe the session again
            if (reason === DisconnectReason.loggedOut || reason === 405) {
                console.log("❌ Critical Error (405/Logout). Restarting fresh...");
                // The restart will trigger the wipe at the top of the function
                start();
            } else {
                setTimeout(start, 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ SUCCESS! Bot is Connected.');
            currentQR = null; // Clear QR so nobody else can scan it
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

        // Debug Log
        console.log(`📩 Message: ${text}`);

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
