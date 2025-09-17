import express from "express";
import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";

const TOKEN = "7674031536:AAEYlgD1ufhYXGIs6nYCxOcD1I1NsFLOqrg";
const bot = new TelegramBot(TOKEN, { polling: true });

// --- Express keep-alive server ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("✅ Bot is running!");
});

app.listen(PORT, () => {
  console.log(`🌐 Keep-alive server listening on port ${PORT}`);
});

// --- In-memory task store ---
let tasks = {};

function getTaskList(chatId) {
  if (!tasks[chatId]) tasks[chatId] = [];
  return tasks[chatId];
}

// --- Bot commands ---
bot.onText(/\/add (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const taskText = match[1];
  getTaskList(chatId).push({ task: taskText, done: false });
  bot.sendMessage(chatId, `✅ Task added: ${taskText}`);
});

bot.onText(/\/done (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const taskName = match[1];
  const list = getTaskList(chatId);
  const t = list.find((t) => t.task.toLowerCase() === taskName.toLowerCase());
  if (t) {
    t.done = true;
    bot.sendMessage(chatId, `🎉 Marked done: ${taskName}`);
  } else {
    bot.sendMessage(chatId, `⚠️ Task not found: ${taskName}`);
  }
});

bot.onText(/\/list/, (msg) => {
  const chatId = msg.chat.id;
  const list = getTaskList(chatId);
  if (list.length === 0) {
    bot.sendMessage(chatId, "📭 No tasks found. Use /add <task> to create one.");
  } else {
    const formatted = list
      .map((t) => `${t.done ? "✅" : "⏳"} ${t.task}`)
      .join("\n");
    bot.sendMessage(chatId, `📋 Your tasks:\n${formatted}`);
  }
});

// --- Scheduled reminders ---
async function sendReminders() {
  for (const [chatId, userTasks] of Object.entries(tasks)) {
    const pending = userTasks.filter((t) => !t.done);
    if (pending.length > 0) {
      const list = pending.map((t) => `⏳ ${t.task}`).join("\n");
      await bot.sendMessage(chatId, `🔔 Reminder:\n${list}`);
    }
  }
}

cron.schedule("0 10 * * *", sendReminders, { timezone: "Asia/Kolkata" });
cron.schedule("0 17 * * *", sendReminders, { timezone: "Asia/Kolkata" });

console.log("✅ Telegram Task Bot is running...");
