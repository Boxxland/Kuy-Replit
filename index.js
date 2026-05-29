const { Client, GatewayIntentBits, AttachmentBuilder } = require("discord.js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const gTTS = require("gtts");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

// ---- Database Setup ----
const db = new Database("bot_data.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

function getHistory(key) {
  const rows = db.prepare("SELECT role, content FROM history WHERE key = ? ORDER BY id ASC").all(key);
  return rows.map(r => ({ role: r.role, parts: [{ text: r.content }] }));
}

function saveMessage(key, role, content) {
  db.prepare("INSERT INTO history (key, role, content) VALUES (?, ?, ?)").run(key, role, content);
  // จำกัดไม่เกิน 20 rows ต่อ key
  const count = db.prepare("SELECT COUNT(*) as c FROM history WHERE key = ?").get(key).c;
  if (count > 20) {
    const oldest = db.prepare("SELECT id FROM history WHERE key = ? ORDER BY id ASC LIMIT ?").all(key, count - 20);
    const ids = oldest.map(r => r.id);
    db.prepare(`DELETE FROM history WHERE id IN (${ids.join(",")})`).run();
  }
}

function clearHistory(key) {
  db.prepare("DELETE FROM history WHERE key = ?").run(key);
}

// ---- Gemini Setup ----
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-2.0-flash",
  systemInstruction: `คุณคือผู้ช่วย AI เพื่อการศึกษา ในเซิร์ฟเวอร์ Discord
อธิบายเนื้อหาวิชาการได้ทุกระดับ ตั้งแต่ประถมถึงมหาวิทยาลัย
ใช้ภาษาเข้าใจง่าย ยกตัวอย่างประกอบเสมอ
รองรับทั้งภาษาไทยและภาษาอังกฤษ
ถ้าตอบยาว แบ่งเป็นข้อๆ ให้อ่านง่าย`,
});

// ---- Discord Client ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

client.once("ready", () => {
  console.log(`✅ บอทออนไลน์แล้ว! เข้าสู่ระบบในชื่อ ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const isMentioned = message.mentions.has(client.user);
  const isDM = message.channel.type === 1;
  const content = message.content.trim();
  const historyKey = isDM ? `dm-${message.author.id}` : `ch-${message.channel.id}`;

  // ---- !help ----
  if (content === "!help") {
    return message.reply(`📚 **คำสั่งทั้งหมด**

🤖 \`!ask <คำถาม>\` — ถามคำถามกับ AI
🎨 \`!image <คำอธิบาย>\` — สร้างรูปภาพ
🔊 \`!speak <ข้อความ>\` — แปลงข้อความเป็นเสียง
🗑️ \`!clear\` — ล้างประวัติสนทนา
❓ \`!help\` — แสดงคำสั่งทั้งหมด

หรือจะ **mention บอท** / **DM** ตรงๆ ก็ได้เลยครับ!`);
  }

  // ---- !clear ----
  if (content === "!clear") {
    clearHistory(historyKey);
    return message.reply("🗑️ ล้างประวัติสนทนาแล้วครับ!");
  }

  // ---- !image ----
  if (content.startsWith("!image ")) {
    const prompt = content.slice(7).trim();
    if (!prompt) return message.reply("❌ กรุณาใส่คำอธิบายรูปด้วยครับ เช่น `!image แมวใส่หมวก`");
    await message.channel.sendTyping();
    try {
      const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
      const response = await axios.get(imageUrl, { responseType: "arraybuffer" });
      const attachment = new AttachmentBuilder(Buffer.from(response.data), { name: "image.png" });
      return message.reply({ content: `🎨 **${prompt}**`, files: [attachment] });
    } catch (err) {
      console.error(err);
      return message.reply("❌ สร้างรูปไม่สำเร็จ ลองใหม่อีกครั้งนะครับ");
    }
  }

  // ---- !speak ----
  if (content.startsWith("!speak ")) {
    const text = content.slice(7).trim();
    if (!text) return message.reply("❌ กรุณาใส่ข้อความด้วยครับ เช่น `!speak สวัสดีครับ`");
    await message.channel.sendTyping();
    const filePath = path.join("/tmp", `tts_${Date.now()}.mp3`);
    try {
      await new Promise((resolve, reject) => {
        const lang = /[\u0E00-\u0E7F]/.test(text) ? "th" : "en";
        const tts = new gTTS(text, lang);
        tts.save(filePath, (err) => (err ? reject(err) : resolve()));
      });
      const attachment = new AttachmentBuilder(filePath, { name: "speech.mp3" });
      await message.reply({ content: `🔊 **${text}**`, files: [attachment] });
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error(err);
      return message.reply("❌ แปลงเสียงไม่สำเร็จ ลองใหม่อีกครั้งนะครับ");
    }
    return;
  }

  // ---- !ask / mention / DM → Gemini ----
  let userMessage = "";
  if (content.startsWith("!ask ")) {
    userMessage = content.slice(5).trim();
  } else if (isMentioned || isDM) {
    userMessage = content.replace(/<@!?\d+>/g, "").trim();
  } else {
    return;
  }

  if (!userMessage) {
    return message.reply("สวัสดีครับ! พิมพ์ `!help` เพื่อดูคำสั่งทั้งหมดได้เลยครับ 😊");
  }

  try {
    await message.channel.sendTyping();

    const history = getHistory(historyKey);
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(userMessage);
    const replyText = result.response.text();

    saveMessage(historyKey, "user", userMessage);
    saveMessage(historyKey, "model", replyText);

    if (replyText.length <= 2000) {
      await message.reply(replyText);
    } else {
      const chunks = replyText.match(/.{1,2000}/gs) || [];
      for (const chunk of chunks) await message.channel.send(chunk);
    }
  } catch (error) {
    console.error("Error:", error);
    await message.reply("❌ เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้งนะครับ");
  }
});

client.login(process.env.DISCORD_TOKEN);
