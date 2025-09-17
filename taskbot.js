import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import express from "express";

const TOKEN = "7674031536:AAEYlgD1ufhYXGIs6nYCxOcD1I1NsFLOqrg"; 
const bot = new TelegramBot(TOKEN, { polling: true });

// --- Simple In-Memory Task Store ---
let tasks = {};
function getTaskList(chatId) {
  if (!tasks[chatId]) tasks[chatId] = [];
  return tasks[chatId];
}

// --- Main Menu ---
function mainMenu(chatId) {
  bot.sendMessage(chatId, "📋 What do you want to do?", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ Add Task", callback_data: "add_task" }],
        [{ text: "✅ Mark Task Done", callback_data: "mark_done" }],
        [{ text: "✏️ Edit Task", callback_data: "edit_task" }],
        [{ text: "🗑 Delete Task", callback_data: "delete_task" }],
        [{ text: "📜 Show Tasks", callback_data: "show_tasks" }],
      ],
    },
  });
}

// --- Start Command ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "👋 Hi! I'm your Task Bot. Let's stay productive!");
  mainMenu(chatId);
});

// --- Handle Buttons ---
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  // ➕ Add Task
  if (data === "add_task") {
    await bot.sendMessage(chatId, "✍️ Send me the task you want to add:");
    bot.once("message", (msg) => {
      getTaskList(chatId).push({ task: msg.text, done: false });
      bot.sendMessage(chatId, `✅ Task added: ${msg.text}`);
      mainMenu(chatId);
    });
  }

  // ✅ Mark Task Done
  if (data === "mark_done") {
    const list = getTaskList(chatId).filter((t) => !t.done);
    if (list.length === 0) {
      bot.sendMessage(chatId, "🎉 No pending tasks!");
      return mainMenu(chatId);
    }
    const buttons = list.map((t, i) => [{ text: `⏳ ${t.task}`, callback_data: `done_${i}` }]);
    bot.sendMessage(chatId, "Select a task to mark done:", {
      reply_markup: { inline_keyboard: buttons },
    });
  }

  if (data.startsWith("done_")) {
    const index = parseInt(data.split("_")[1]);
    const list = getTaskList(chatId);
    if (list[index]) {
      list[index].done = true;
      bot.sendMessage(chatId, `🎉 Marked done: ${list[index].task}`);
    }
    mainMenu(chatId);
  }

  // ✏️ Edit Task
  if (data === "edit_task") {
    const list = getTaskList(chatId);
    if (list.length === 0) {
      bot.sendMessage(chatId, "📭 No tasks to edit.");
      return mainMenu(chatId);
    }
    const buttons = list.map((t, i) => [{ text: `${t.done ? "✅" : "⏳"} ${t.task}`, callback_data: `edit_${i}` }]);
    bot.sendMessage(chatId, "Select a task to edit:", {
      reply_markup: { inline_keyboard: buttons },
    });
  }

  if (data.startsWith("edit_")) {
    const index = parseInt(data.split("_")[1]);
    const list = getTaskList(chatId);
    if (!list[index]) return mainMenu(chatId);

    await bot.sendMessage(chatId, `✍️ Send the new text for "${list[index].task}":`);
    bot.once("message", (msg) => {
      list[index].task = msg.text;
      bot.sendMessage(chatId, `✏️ Task updated to: ${msg.text}`);
      mainMenu(chatId);
    });
  }

  // 🗑 Delete Task
  if (data === "delete_task") {
    const list = getTaskList(chatId);
    if (list.length === 0) {
      bot.sendMessage(chatId, "📭 No tasks to delete.");
      return mainMenu(chatId);
    }
    const buttons = list.map((t, i) => [{ text: `${t.done ? "✅" : "⏳"} ${t.task}`, callback_data: `delete_${i}` }]);
    bot.sendMessage(chatId, "Select a task to delete:", {
      reply_markup: { inline_keyboard: buttons },
    });
  }

  if (data.startsWith("delete_")) {
    const index = parseInt(data.split("_")[1]);
    const list = getTaskList(chatId);
    if (list[index]) {
      const removed = list.splice(index, 1);
      bot.sendMessage(chatId, `🗑 Deleted task: ${removed[0].task}`);
    }
    mainMenu(chatId);
  }

  // 📜 Show Tasks
  if (data === "show_tasks") {
    const list = getTaskList(chatId);
    if (list.length === 0) {
      bot.sendMessage(chatId, "📭 No tasks found.");
    } else {
      const formatted = list
        .map((t) => `${t.done ? "✅" : "⏳"} ${t.task}`)
        .join("\n");
      bot.sendMessage(chatId, `📋 Your tasks:\n${formatted}`);
    }
    mainMenu(chatId);
  }
});

// --- Daily Reminders ---
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

// --- Keep Alive on Render ---
const app = express();
app.get("/", (req, res) => res.send("✅ Telegram Task Bot is running!"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web service running on port ${PORT}`));

console.log("✅ Telegram Task Bot with Full CRUD is running...");
