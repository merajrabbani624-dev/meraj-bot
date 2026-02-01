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
const OWNER_NUMBER = "917001747616@s.whatsapp.net"; // Your Number
const AUTH_FOLDER = './auth_info';
const DB_FILE = './database.json';

// ==================== DATABASE SYSTEM (Credits & Knowledge) ====================
// This simple system saves data to a file so it remembers credits and saved items.
let db = {
  users: {},      // Stores credits: { "123@s.whatsapp.net": 5 }
  knowledge: {}   // Stores saved info: { "wifi_pass": "123456" }
};

// Load Database
if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE)); } catch {}
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Helper: Get Credits
function getCredits(user) {
  if (user === OWNER_NUMBER) return 999999; // Owner is infinite
  if (!db.users[user]) db.users[user] = { credits: 1 }; // Default 1 free credit
  return db.users[user].credits;
}

// Helper: Use Credit
function useCredit(user) {
  if (user === OWNER_NUMBER) return true;
  if (getCredits(user) > 0) {
    db.users[user].credits -= 1;
    saveDB();
    return true;
  }
  return false;
}

// ==================== GLOBAL STATE ====================
let sock = null;
let qrDataURL = null;
let connectionStatus = 'Disconnected';
const app = express();

// ==================== WEB SERVER ====================
app.get('/', (req, res) => res.send(`
  <html><head><meta http-equiv="refresh" content="5"></head>
  <body style="text-align:center; padding:50px; font-family:sans-serif;">
    <h1>🤖 Meraj Ultimate Bot</h1>
    <p>Status: <strong>${connectionStatus}</strong></p>
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

// ==================== CORE BOT LOGIC ====================
async function start() {
  if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER);
  
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
    logger: pino({ level: 'silent' }), // Clean logs
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
      // ONLY Wipe if actually logged out (401)
      if (reason === DisconnectReason.loggedOut) {
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      } 
      // Always reconnect
      setTimeout(start, 3000);
    } else if (connection === 'open') {
      console.log('✅ Connected!');
      connectionStatus = 'Connected';
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ==================== MESSAGE HANDLER ====================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;
    
    const from = msg.key.remoteJid;
    const isOwner = from === OWNER_NUMBER;
    
    // 1. Extract Body (Command)
    const text = msg.message.conversation || 
                 msg.message.extendedTextMessage?.text || 
                 msg.message.imageMessage?.caption || "";
    
    if (!text.startsWith('.')) return; // Ignore non-commands

    const command = text.split(' ')[0].toLowerCase();
    const args = text.split(' ').slice(1).join(' ');

    // 2. Extract Quoted Context (The "Reply" Logic)
    const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || "";
    
    // 3. Helper Reply Function
    const reply = (txt) => sock.sendMessage(from, { text: txt }, { quoted: msg });

    console.log(`📩 Command: ${command} from ${from.split('@')[0]}`);

    // ==================== COMMANDS ====================

    // --- 1. .ask (The AI Brain) ---
    if (command === '.ask') {
      if (!args && !quotedText) return reply("❌ Usage: .ask [question] (or reply to text)");
      
      // Check Credits
      if (!useCredit(from)) return reply("❌ You have 0 credits. Ask owner to top-up.");

      try {
        const genAI = new GoogleGenerativeAI(API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        // Prepare Knowledge Base Context
        const knowledgeDump = JSON.stringify(db.knowledge);
        
        // Build the sophisticated prompt
        let finalPrompt = `System: You are Meraj AI. You have access to this saved knowledge: ${knowledgeDump}.\n`;
        
        if (quotedText) {
          finalPrompt += `\nUSER REPLIED TO THIS MESSAGE:\n"${quotedText}"\n\n`;
        }
        finalPrompt += `USER QUESTION: ${args}`;

        const result = await model.generateContent(finalPrompt);
        await reply(result.response.text());
        
      } catch (err) {
        reply("❌ AI Error: " + err.message);
      }
    }

    // --- 2. .save (Memory) ---
    else if (command === '.save') {
      if (!quotedText) return reply("❌ Please reply to a message to save it.");
      if (!args) return reply("❌ Usage: reply to text -> .save [name]");
      
      db.knowledge[args.toLowerCase()] = quotedText;
      saveDB();
      reply(`✅ Saved to AI Memory as "${args}".\nAI can now use this info.`);
    }

    // --- 3. .credit (Owner Only) ---
    else if (command === '.credit') {
      if (!isOwner) return reply("❌ Owner only.");
      if (!quotedMsg) return reply("❌ Reply to a user to give credits.");
      
      // Get the number of the person quoted
      const targetUser = msg.message.extendedTextMessage.contextInfo.participant;
      const amount = parseInt(args) || 5; // Default 5
      
      if (!db.users[targetUser]) db.users[targetUser] = { credits: 0 };
      db.users[targetUser].credits += amount;
      saveDB();
      
      reply(`✅ Added ${amount} credits to user.`);
      // Notify the user
      await sock.sendMessage(targetUser, { text: `🎉 You received ${amount} AI credits from Owner!` });
    }

    // --- 4. .balance (Check Credits) ---
    else if (command === '.balance') {
      const creds = getCredits(from);
      reply(`💳 You have: ${creds === 999999 ? 'UNLIMITED' : creds} credits.`);
    }

    // --- 5. .summarize (Utility) ---
    else if (command === '.summarize') {
       if (!quotedText) return reply("❌ Reply to a long text to summarize.");
       if (!useCredit(from)) return reply("❌ No credits.");
       
       const model = new GoogleGenerativeAI(API_KEY).getGenerativeModel({ model: "gemini-1.5-flash" });
       const res = await model.generateContent(`Summarize this in 3 bullet points:\n${quotedText}`);
       reply(res.response.text());
    }

    // --- 6. .tr (Translate) ---
    else if (command === '.tr') {
       if (!quotedText) return reply("❌ Reply to text to translate.");
       const lang = args || "English";
       const model = new GoogleGenerativeAI(API_KEY).getGenerativeModel({ model: "gemini-1.5-flash" });
       const res = await model.generateContent(`Translate this to ${lang}:\n${quotedText}`);
       reply(res.response.text());
    }

    // --- 7. .ping ---
    else if (command === '.ping') {
      reply("🏓 Pong! Bot is Online.");
    }

    // --- 8. .alive ---
    else if (command === '.alive') {
       const uptime = process.uptime();
       reply(`🤖 System Active.\nUptime: ${Math.floor(uptime)} seconds.\nMode: ${isOwner ? "Owner" : "User"}`);
    }

    // --- 9. .owner ---
    else if (command === '.owner') {
      // Send vCard or contact
      reply(`👤 *Bot Owner*\nName: Meraj\nContact: wa.me/${OWNER_NUMBER.split('@')[0]}`);
    }

    // --- 10. .joke ---
    else if (command === '.joke') {
       const model = new GoogleGenerativeAI(API_KEY).getGenerativeModel({ model: "gemini-1.5-flash" });
       const res = await model.generateContent(`Tell me a short funny joke.`);
       reply(res.response.text());
    }

    // --- 11. .help ---
    else if (command === '.help') {
      const menu = `
🤖 *MERAJ BOT MENU* 🤖

*AI Commands (Costs 1 Credit):*
🔹 *.ask [query]* - Ask AI (Reply to msg for context!)
🔹 *.summarize* - Summarize quoted text
🔹 *.tr [lang]* - Translate quoted text
🔹 *.joke* - Tell a joke

*Tools:*
🔸 *.save [name]* - Save quoted text to AI memory
🔸 *.balance* - Check your credits
🔸 *.ping* - Check latency
🔸 *.owner* - Contact Owner
🔸 *.alive* - System status

*Owner Only:*
🔑 *.credit [amount]* - Reply to user to give credits
`;
      reply(menu);
    }

  });
}

// Start Server
app.listen(PORT, () => console.log(`🌍 Server on port ${PORT}`));
start();
