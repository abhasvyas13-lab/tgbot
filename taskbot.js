// telegram-task-bot.js
import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";

// 1. Get your token from BotFather on Telegram
const TOKEN = "7674031536:AAEYlgD1ufhYXGIs6nYCxOcD1I1NsFLOqrg"; 
const bot = new TelegramBot(TOKEN, { polling: true });

// Simple in-memory task store: { chatId: [ { task, done } ] }
let tasks = {};

// Helper: get or init task list
function getTaskList(chatId) {
  if (!tasks[chatId]) tasks[chatId] = [];
  return tasks[chatId];
}

// --- Command Handlers ---
bot.onText(/\/add (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const taskText = match[1];
  const list = getTaskList(chatId);
  list.push({ task: taskText, done: false });
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

// Default reply if user sends text without a command
bot.on("message", (msg) => {
  if (!msg.text.startsWith("/")) {
    bot.sendMessage(
      msg.chat.id,
      "Hi! I am your Task Bot.\nUse:\n/add <task>\n/done <task>\n/list"
    );
  }
});

// --- Scheduled Reminders (10 AM & 4 PM) ---
async function sendReminders() {
  for (const [chatId, userTasks] of Object.entries(tasks)) {
    const pending = userTasks.filter((t) => !t.done);
    if (pending.length > 0) {
      const list = pending.map((t) => `⏳ ${t.task}`).join("\n");
      await bot.sendMessage(chatId, `🔔 Reminder:\n${list}`);
    }
  }
}

// Runs at 10:00 and 16:00 daily (server time)

cron.schedule("0 10 * * *", sendReminders, {
  timezone: "Asia/Kolkata",
});

cron.schedule("10 17 * * *", sendReminders, {
  timezone: "Asia/Kolkata",
});

console.log("✅ Telegram Task Bot is running...");
