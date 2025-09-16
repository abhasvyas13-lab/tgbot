// telegram-task-bot.js
import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";

const TOKEN = "7674031536:AAEYlgD1ufhYXGIs6nYCxOcD1I1NsFLOqrg"; // <-- Replace with your real token
const bot = new TelegramBot(TOKEN, { polling: true });

let tasks = {}; // { chatId: [ { task, done } ] }
let awaitingInput = {}; // Tracks if user is adding a task

function getTaskList(chatId) {
  if (!tasks[chatId]) tasks[chatId] = [];
  return tasks[chatId];
}

// --- Show Main Menu ---
function showMainMenu(chatId) {
  bot.sendMessage(chatId, "🤖 What would you like to do?", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ Add Task", callback_data: "ADD_TASK" }],
        [{ text: "📋 List Tasks", callback_data: "LIST_TASKS" }],
      ],
    },
  });
}

// --- Handle Callback Buttons ---
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;

  if (query.data === "ADD_TASK") {
    awaitingInput[chatId] = true;
    await bot.sendMessage(chatId, "✏️ Please type your new task:");
  }

  if (query.data === "LIST_TASKS") {
    sendTaskList(chatId);
  }

  if (query.data.startsWith("DONE_")) {
    const taskIndex = parseInt(query.data.split("_")[1]);
    const list = getTaskList(chatId);
    if (list[taskIndex]) {
      list[taskIndex].done = true;
      await bot.sendMessage(chatId, `🎉 Marked done: ${list[taskIndex].task}`);
      sendTaskList(chatId); // Refresh list
    }
  }

  bot.answerCallbackQuery(query.id);
});

// --- Capture User Input (for Adding Task) ---
bot.on("message", (msg) => {
  const chatId = msg.chat.id;

  if (awaitingInput[chatId]) {
    const list = getTaskList(chatId);
    list.push({ task: msg.text, done: false });
    bot.sendMessage(chatId, `✅ Task added: ${msg.text}`);
    awaitingInput[chatId] = false;
    showMainMenu(chatId);
    return;
  }

  if (!msg.text.startsWith("/")) {
    showMainMenu(chatId);
  }
});

// --- Send Task List with Inline Buttons ---
function sendTaskList(chatId) {
  const list = getTaskList(chatId);

  if (list.length === 0) {
    bot.sendMessage(chatId, "📭 No tasks found. Tap ➕ Add Task to create one.");
    return;
  }

  const taskButtons = list.map((t, index) => [
    {
      text: t.done ? `✅ ${t.task}` : `⏳ ${t.task}`,
      callback_data: t.done ? "IGNORE" : `DONE_${index}`,
    },
  ]);

  bot.sendMessage(chatId, "📋 Your tasks:", {
    reply_markup: {
      inline_keyboard: taskButtons,
    },
  });
}

// --- Scheduled Reminders (10 AM & 4 PM) ---
async function sendReminders() {
  for (const [chatId, userTasks] of Object.entries(tasks)) {
    const pending = userTasks.filter((t) => !t.done);
    if (pending.length > 0) {
      const list = pending.map((t, i) => `⏳ ${t.task}`).join("\n");
      await bot.sendMessage(chatId, `🔔 Reminder:\n${list}`);
    }
  }
}

// Run reminders daily
cron.schedule("0 10 * * *", sendReminders, { timezone: "Asia/Kolkata" });
cron.schedule("0 16 * * *", sendReminders, { timezone: "Asia/Kolkata" });

console.log("✅ Telegram Task Bot with Buttons is running...");
