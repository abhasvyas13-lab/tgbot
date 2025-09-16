import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";

const TOKEN = "7674031536:AAEYlgD1ufhYXGIs6nYCxOcD1I1NsFLOqrg";
const bot = new TelegramBot(TOKEN, { polling: true });

let tasks = {};

function getTaskList(chatId) {
  if (!tasks[chatId]) tasks[chatId] = [];
  return tasks[chatId];
}

function showMainMenu(chatId) {
  bot.sendMessage(chatId, "🤖 What would you like to do?", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ Add Task", callback_data: "add" }],
        [{ text: "📋 List Tasks", callback_data: "list" }],
      ],
    },
  });
}

// --- Commands ---
bot.onText(/\/start/, (msg) => {
  showMainMenu(msg.chat.id); // ✅ Only call here
});

// --- Button Actions ---
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  if (query.data === "add") {
    await bot.sendMessage(chatId, "✍️ Please send me the task text.");
    bot.once("message", (msg) => {
      const list = getTaskList(chatId);
      list.push({ task: msg.text, done: false });
      bot.sendMessage(chatId, `✅ Task added: ${msg.text}`);
      showMainMenu(chatId); // Show menu only after task added
    });
  } else if (query.data === "list") {
    const list = getTaskList(chatId);
    if (list.length === 0) {
      bot.sendMessage(chatId, "📭 No tasks found.");
    } else {
      const formatted = list
        .map((t) => `${t.done ? "✅" : "⏳"} ${t.task}`)
        .join("\n");
      bot.sendMessage(chatId, `📋 Your tasks:\n${formatted}`);
    }
    showMainMenu(chatId); // Show menu after listing tasks
  }
});

// --- Reminder Logic ---
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
cron.schedule("0 16 * * *", sendReminders, { timezone: "Asia/Kolkata" });

console.log("✅ Telegram Task Bot is running...");
