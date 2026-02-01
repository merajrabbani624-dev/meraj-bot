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

// ==================== CONFIGURATION ====================
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY; 
const AUTH_FOLDER = './auth_info';
const DB_FILE = './database.json';

// ==================== DATABASE (Credits & Memory) ====================
let db = {
  users: {},      
  knowledge: {}   
};

// Load Database
if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE)); } catch {}
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// 1. Get Credits (Owner is Unlimited)
function getCredits(user, isOwner) {
  if (isOwner) return "UNLIMITED"; 
  if (!db.users[user]) db.users[user] = { credits: 1 }; // 1 Free Credit for strangers
  return db.users[user].credits;
}

// 2. Use Credit (Owner bypasses)
function useCredit(user, isOwner) {
  if (isOwner) return true; // Owner never uses credits
  if (getCredits(user, false) > 0) {
    db.users[user].credits -= 1;
    saveDB();
    return true;
  }
  return false;
}

// ==================== SERVER & STATE ====================
const app = express();
let sock = null;
let qrDataURL = null;
let connectionStatus = 'Disconnected';
let ownerJid = null; // Will be auto-filled on login

app.get('/', (req, res) => res.send(`
  <html><head><meta http-equiv="refresh" content="5"></head>
  <body style="text-align:center; padding:50px; font-family:sans-serif;">
    <h1>🤖 Meraj Auto-Bot</h1>
    <p>Status: <strong>${connectionStatus}</strong></p>
    <p>Owner: <strong>${ownerJid ? "✅ Detected" : "Waiting..."}</strong></p>
    ${connectionStatus !== 'Connected' ? '<a href="/qr">Scan QR</a>' : '✅ System Online'}
  </body></html>
`));

app.get('/qr', (req, res) => {
  if (qrDataURL && connectionStatus !== 'Connected') {
    res.send(`<div style="text-align:center;"><img src="${qrDataURL}" style="width:300px; border:5px solid green;"/></div>`);
  } else {
    res.send('<h2>Bot is connected!</h2>');
  }
});

// ==================== BOT LOGIC ====================
async function start() {
  if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER);
  
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    connectTimeoutMs: 60000,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log('✨ QR Generated');
      qrDataURL = await QRCode.toDataURL(qr);
      connectionStatus = 'Scan QR';
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`⚠️ Connection closed: ${reason}`);
      connectionStatus = 'Disconnected';
      // Only wipe if logged out (401)
      if (reason === DisconnectReason.loggedOut) {
        console.log('❌ Logged out. Wiping session.');
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        ownerJid = null;
      }
      setTimeout(start, 3000);
    } 
    
    else if (connection === 'open') {
      console.log('✅ Connected!');
      connectionStatus = 'Connected';
      
      // AUTO-DETECT OWNER from Session
      // sock.user.id comes like "917001...@s.whatsapp.net:5" -> We clean it
      if (sock.user && sock.user.id) {
        ownerJid = sock.user.id.split(':')[0] + "@s.whatsapp.net";
        console.log(`👑 OWNER AUTO-DETECTED: ${ownerJid}`);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ==================== MESSAGE HANDLER ====================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;
    
    const from = msg.key.remoteJid;
    // CRITICAL: Check if message is FROM ME (The Owner)
    const isOwner = msg.key.fromMe || (ownerJid && from === ownerJid);
    
    // 1. Get Text
    const text = msg.message.conversation || 
                 msg.message.extendedTextMessage?.text || 
                 msg.message.imageMessage?.caption || "";
    
    if (!text.startsWith('.')) return;

    const command = text.split(' ')[0].toLowerCase();
    const args = text.split(' ').slice(1).join(' ');

    // 2. Get Context (Reply)
    const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || "";
    
    const reply = (txt) => sock.sendMessage(from, { text: txt }, { quoted: msg });

    console.log(`📩 Cmd: ${command} | Sender: ${isOwner ? "OWNER" : "User"}`);

    // --- COMMANDS ---

    // 1. .ask (Context Aware)
    if (command === '.ask') {
      if (!args && !quotedText) return reply("❌ Usage: .ask [query] (or reply to text)");
      
      if (!useCredit(from, isOwner)) return reply("❌ 0 Credits. Ask owner for more.");

      try {
        const genAI = new GoogleGenerativeAI(API_KEY);
        // Using 'gemini-flash-latest' (Change to 'gemini-pro' if flash fails)
        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

        const knowledgeDump = JSON.stringify(db.knowledge);
        let finalPrompt = `System: You are Meraj AI. Knowledge Base: ${knowledgeDump}.\n`;
        
        if (quotedText) finalPrompt += `\nCONTEXT (User Replied to):\n"${quotedText}"\n\n`;
        finalPrompt += `QUESTION: ${args}`;

        const result = await model.generateContent(finalPrompt);
        await reply(result.response.text());
        
      } catch (err) {
        reply("❌ AI Error: " + err.message);
      }
    }

    // 2. .save (Memory)
    else if (command === '.save') {
      if (!quotedText) return reply("❌ Reply to a message to save it.");
      if (!args) return reply("❌ Usage: .save [name]");
      
      db.knowledge[args.toLowerCase()] = quotedText;
      saveDB();
      reply(`✅ Saved "${args}" to memory.`);
    }

    // 3. .credit (Owner Only)
    else if (command === '.credit') {
      if (!isOwner) return reply("🛑 Owner Only Command.");
      
      // We need to find WHO to give credits to.
      // 1. Check if replying to someone
      const target = msg.message.extendedTextMessage?.contextInfo?.participant;
      
      if (!target) return reply("❌ Reply to a user's message to give credits.");
      
      const amount = parseInt(args) || 5;
      if (!db.users[target]) db.users[target] = { credits: 0 };
      db.users[target].credits += amount;
      saveDB();
      
      reply(`✅ Gave ${amount} credits to that user.`);
    }

    // 4. .balance
    else if (command === '.balance') {
      const c = getCredits(from, isOwner);
      reply(`💳 Credits: ${c}`);
    }

    // 5. .help
    else if (command === '.help') {
      reply(`
🤖 *MERAJ BOT* ----------------
🔹 .ask [query] (AI)
🔹 .save [name] (Save Info)
🔹 .balance (Check Credits)
🔹 .ping (Test)
${isOwner ? "\n👑 *Owner Cmds:*\n🔹 .credit [amount] (Reply to user)" : ""}
`);
    }

    else if (command === '.ping') reply("🏓 Pong!");

  });
}

// Start
app.listen(PORT, () => console.log(`🌍 Server on port ${PORT}`));
start();
