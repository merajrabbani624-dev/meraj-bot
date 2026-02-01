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
const AUTH_FOLDER = './auth_info';
const DB_FILE = './database.json';

// --- API KEY ROTATION SYSTEM ---
// Load all available keys from Environment Variables
const apiKeys = [
  process.env.API_KEY,
  process.env.API_KEY1,
  process.env.API_KEY2,
  process.env.API_KEY3,
  process.env.API_KEY4,
  process.env.API_KEY5
].filter(k => !!k); // Remove empty ones

if (apiKeys.length === 0) console.error("❌ NO API KEYS FOUND! Set API_KEY in env.");
else console.log(`✅ Loaded ${apiKeys.length} AI API Keys for rotation.`);

let currentKeyIndex = 0;

// Smart Generate Function with Auto-Rotation
async function generateSmartAI(prompt) {
  // Try looping through all keys
  for (let i = 0; i < apiKeys.length; i++) {
    try {
      // Get current key (using modulo to loop back to 0 if needed)
      const key = apiKeys[(currentKeyIndex + i) % apiKeys.length];
      const genAI = new GoogleGenerativeAI(key);
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      
      const result = await model.generateContent(prompt);
      return result.response.text();
      
    } catch (err) {
      console.warn(`⚠️ Key ${currentKeyIndex} Failed: ${err.message}. Switching...`);
      // If error is strictly QUOTA or PERMISSION, rotate. Else might be logic error.
      // But for safety, we rotate on almost any error.
    }
  }
  return "❌ System Overload: All API Quotas Exhausted. Please add more keys.";
}

// ==================== DATABASE ====================
let db = { users: {}, knowledge: {} };
if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE)); } catch {}
}
function saveDB() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

function useCredit(user, isOwner) {
  if (isOwner) return true;
  if (!db.users[user]) db.users[user] = { credits: 3 }; // 3 Free credits
  if (db.users[user].credits > 0) {
    db.users[user].credits--;
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
let ownerJid = null;

app.get('/', (req, res) => res.send(`
  <html><head><meta http-equiv="refresh" content="5"></head>
  <body style="text-align:center; padding:50px; font-family:sans-serif;">
    <h1>🤖 Meraj Ultimate Bot V2</h1>
    <p>Status: <strong>${connectionStatus}</strong></p>
    <p>Owner: <strong>${ownerJid ? "✅ Detected" : "Waiting..."}</strong></p>
    <p>Active API Keys: ${apiKeys.length}</p>
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
    if (qr) { qrDataURL = await QRCode.toDataURL(qr); connectionStatus = 'Scan QR'; }
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        ownerJid = null;
      }
      setTimeout(start, 3000);
    } else if (connection === 'open') {
      connectionStatus = 'Connected';
      if (sock.user?.id) ownerJid = sock.user.id.split(':')[0] + "@s.whatsapp.net";
      console.log(`👑 Owner: ${ownerJid}`);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;
    const from = msg.key.remoteJid;
    const isOwner = msg.key.fromMe || (ownerJid && from === ownerJid);
    
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
    if (!text.startsWith('.')) return;

    const command = text.split(' ')[0].toLowerCase();
    const args = text.split(' ').slice(1).join(' ');
    const reply = (txt) => sock.sendMessage(from, { text: txt }, { quoted: msg });
    const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || "";

    console.log(`📩 Cmd: ${command}`);

    // ==================== 🧠 CORE AI COMMANDS ====================

    if (command === '.ask') {
      if (!useCredit(from, isOwner)) return reply("❌ 0 Credits.");
      if (!args && !quotedText) return reply("❓ Ask something.");
      
      const knowledge = JSON.stringify(db.knowledge);
      let prompt = `System: You are Meraj AI. You have saved knowledge: ${knowledge}.\n`;
      if (quotedText) prompt += `Context: "${quotedText}"\n`;
      prompt += `User: ${args}`;

      reply(await generateSmartAI(prompt));
    }

    // ==================== 💾 MEMORY SYSTEM ====================

    else if (command === '.save') {
      if (!quotedText) return reply("❌ Reply to a text to save it.");
      if (!args) return reply("❌ Usage: .save [name]");
      db.knowledge[args.toLowerCase()] = quotedText;
      saveDB();
      reply(`💾 Saved as "${args}".`);
    }

    else if (command === '.get') {
      if (!args) return reply("❌ Usage: .get [name]");
      const val = db.knowledge[args.toLowerCase()];
      reply(val ? `📂 *${args}*:\n${val}` : "❌ Not found.");
    }

    else if (command === '.list') {
      const keys = Object.keys(db.knowledge);
      reply(keys.length > 0 ? `📚 *Saved Items:*\n${keys.join('\n')}` : "❌ Memory empty.");
    }

    else if (command === '.delete') {
      if (!args) return reply("❌ Usage: .delete [name]");
      if (db.knowledge[args.toLowerCase()]) {
        delete db.knowledge[args.toLowerCase()];
        saveDB();
        reply(`🗑️ Deleted "${args}".`);
      } else reply("❌ Not found.");
    }

    // ==================== 🛠️ UTILITY COMMANDS ====================

    else if (command === '.wiki') {
      if (!args) return reply("❌ Usage: .wiki [query]");
      reply(await generateSmartAI(`Summarize this Wikipedia topic in 3 paragraphs: ${args}`));
    }

    else if (command === '.math') {
      if (!args) return reply("❌ Usage: .math [expression]");
      reply(await generateSmartAI(`Solve this math problem step-by-step: ${args}`));
    }

    else if (command === '.weather') {
      if (!args) return reply("❌ Usage: .weather [city]");
      reply(await generateSmartAI(`Give me a fake, funny weather forecast style prediction for: ${args}`));
    }

    else if (command === '.pass') {
      const len = parseInt(args) || 12;
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
      let pass = "";
      for(let i=0; i<len; i++) pass += chars.charAt(Math.floor(Math.random() * chars.length));
      reply(`🔑 Pass: ${pass}`);
    }

    else if (command === '.quote') {
      reply(await generateSmartAI("Give me a random inspirational quote."));
    }

    else if (command === '.fact') {
      reply(await generateSmartAI("Tell me a random interesting fact."));
    }

    else if (command === '.lyrics') {
      if (!args) return reply("❌ Usage: .lyrics [song name]");
      reply(await generateSmartAI(`Find the lyrics for the song: ${args}`));
    }

    // ==================== 🎲 FUN COMMANDS ====================

    else if (command === '.roast') {
      const target = quotedText ? `this message: "${quotedText}"` : (args || "me");
      reply(await generateSmartAI(`Roast ${target} brutally but funny.`));
    }

    else if (command === '.compliment') {
      const target = quotedText ? `this message: "${quotedText}"` : (args || "me");
      reply(await generateSmartAI(`Give a very sweet compliment to ${target}.`));
    }

    else if (command === '.joke') {
      reply(await generateSmartAI("Tell me a funny joke."));
    }

    else if (command === '.8ball') {
      const answers = ["Yes", "No", "Maybe", "Ask again", "Definitely", "Don't count on it"];
      reply(`🎱 ${answers[Math.floor(Math.random() * answers.length)]}`);
    }

    else if (command === '.coin') {
      reply(Math.random() > 0.5 ? "🪙 Heads" : "🪙 Tails");
    }

    // ==================== 👑 OWNER & SYSTEM ====================

    else if (command === '.credit') {
      if (!isOwner) return reply("🛑 Owner Only.");
      const target = msg.message.extendedTextMessage?.contextInfo?.participant;
      if (!target) return reply("❌ Reply to user.");
      const amt = parseInt(args) || 10;
      if (!db.users[target]) db.users[target] = { credits: 0 };
      db.users[target].credits += amt;
      saveDB();
      reply(`✅ Gave ${amt} credits.`);
    }

    else if (command === '.broadcast') {
      if (!isOwner) return reply("🛑 Owner Only.");
      reply("⚠️ Broadcast feature requires database of all chat IDs (not implemented to prevent spam bans).");
    }

    else if (command === '.alive') {
      const mem = process.memoryUsage().rss / 1024 / 1024;
      reply(`🤖 *SYSTEM STATUS*\n🔋 Uptime: ${Math.floor(process.uptime())}s\n🧠 RAM: ${mem.toFixed(2)}MB\n🔑 API Keys: ${apiKeys.length}`);
    }

    else if (command === '.help') {
      reply(`
🤖 *MERAJ BOT V2 COMMANDS*

🧠 *AI & Memory*
.ask [query] - Chat with AI
.save [name] - Save quoted text
.get [name] - Read saved text
.list - List all saved items
.delete [name] - Delete item

🛠️ *Tools*
.wiki [query] - Wikipedia Summary
.math [expr] - Solve Math
.pass [len] - Gen Password
.lyrics [song] - Find Lyrics
.weather [city] - Forecast

🎲 *Fun*
.roast - Roast someone
.compliment - Be nice
.joke - Random Joke
.8ball - Fortune Teller
.coin - Flip Coin
.fact / .quote - Random info

⚙️ *System*
.balance - Check credits
.alive - System stats
.ping - Pong!
`);
    }

    else if (command === '.ping') reply("🏓 Pong!");
  });
}

app.listen(PORT, () => console.log(`🌍 Server on port ${PORT}`));
start();
