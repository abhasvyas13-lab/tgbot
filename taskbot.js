import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import express from "express";
import fetch from "node-fetch";

const TOKEN = "7674031536:AAEYlgD1ufhYXGIs6nYCxOcD1I1NsFLOqrg";
const bot = new TelegramBot(TOKEN, { polling: true });

// --- Persistent Data ---
let tasks = {}; // { chatId: [ {task, done} ] }
let reminderTimes = {}; // { chatId: { morning: "HH:mm", evening: "HH:mm" } }
let reminderJobs = {}; // dynamic cron jobs per user

function getTaskList(chatId) {
  if (!tasks[chatId]) tasks[chatId] = [];
  return tasks[chatId];
}

// --- User State ---
let userStates = {}; // track add/edit states

// --- Pagination Helper ---
function paginate(array, pageSize, page) {
  const totalPages = Math.ceil(array.length / pageSize);
  const slice = array.slice(page * pageSize, (page + 1) * pageSize);
  return { slice, totalPages };
}

// --- Persistent Main Menu ---
function mainMenu(chatId) {
  bot.sendMessage(chatId, "📋 Main Menu", {
    reply_markup: {
      keyboard: [
        ["➕ Add Task", "✅ Mark Task Done"],
        ["✏️ Edit Task", "🗑 Delete Task"],
        ["📜 Show Tasks", "⏰ Set Reminder"],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  });
}

// --- Start Command ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "👋 Hi! I'm your Task Bot. Let's stay productive!");
  mainMenu(chatId);
});

// --- Handle Menu Button Presses ---
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const state = userStates[chatId];

  // Handle states first (add/edit)
  if (state?.mode === "add") {
    getTaskList(chatId).push({ task: text, done: false });
    bot.sendMessage(chatId, `✅ Task added: ${text}`);
    delete userStates[chatId];
    return mainMenu(chatId);
  }

  if (state?.mode === "edit") {
    const list = getTaskList(chatId);
    if (list[state.index]) {
      list[state.index].task = text;
      bot.sendMessage(chatId, `✏️ Task updated: ${text}`);
    }
    delete userStates[chatId];
    return mainMenu(chatId);
  }

  // Menu actions
  if (text === "➕ Add Task") {
    userStates[chatId] = { mode: "add" };
    return bot.sendMessage(chatId, "✍️ Send me the task you want to add:");
  }

  if (text === "✅ Mark Task Done") {
    const list = getTaskList(chatId).filter((t) => !t.done);
    if (list.length === 0) return bot.sendMessage(chatId, "🎉 No pending tasks!");
    return sendPaginatedTasks(chatId, list, "done");
  }

  if (text === "✏️ Edit Task") {
    const list = getTaskList(chatId);
    if (list.length === 0) return bot.sendMessage(chatId, "📭 No tasks to edit.");
    return sendPaginatedTasks(chatId, list, "edit");
  }

  if (text === "🗑 Delete Task") {
    const list = getTaskList(chatId);
    if (list.length === 0) return bot.sendMessage(chatId, "📭 No tasks to delete.");
    return sendPaginatedTasks(chatId, list, "delete");
  }

  if (text === "📜 Show Tasks") {
    const list = getTaskList(chatId);
    if (list.length === 0) return bot.sendMessage(chatId, "📭 No tasks found.");
    return sendPaginatedTasks(chatId, list, "show");
  }

  if (text === "⏰ Set Reminder") {
    return bot.sendMessage(chatId, "Which reminder do you want to set?", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🌅 Morning Reminder", callback_data: "set_morning" }],
          [{ text: "🌆 Evening Reminder", callback_data: "set_evening" }],
        ],
      },
    });
  }
});

// --- Paginated Task Display ---
function sendPaginatedTasks(chatId, list, action, page = 0) {
  const pageSize = 5;
  const { slice, totalPages } = paginate(list, pageSize, page);

  const buttons = slice.map((t, i) => {
    const index = page * pageSize + i;
    return [
      {
        text:
          action === "show"
            ? `${t.done ? "✅" : "⏳"} ${t.task}`
            : action === "done"
            ? `✅ ${t.task}`
            : action === "delete"
            ? `🗑 ${t.task}`
            : `✏️ ${t.task}`,
        callback_data: `${action}_${index}`,
      },
    ];
  });

  if (totalPages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: "⬅ Prev", callback_data: `${action}_page_${page - 1}` });
    if (page < totalPages - 1) nav.push({ text: "Next ➡", callback_data: `${action}_page_${page + 1}` });
    buttons.push(nav);
  }

  bot.sendMessage(chatId, `📋 Tasks (Page ${page + 1}/${totalPages}):`, {
    reply_markup: { inline_keyboard: buttons },
  });
}

// --- Inline Callback Handlers ---
bot.on("callback_query", (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.includes("_page_")) {
    const [action, , page] = data.split("_");
    return sendPaginatedTasks(chatId, getTaskList(chatId), action, parseInt(page));
  }

  if (data.startsWith("done_")) {
    const index = parseInt(data.split("_")[1]);
    const list = getTaskList(chatId);
    if (list[index]) {
      list[index].done = true;
      bot.sendMessage(chatId, `✅ Completed: ${list[index].task}`);
    }
    return mainMenu(chatId);
  }

  if (data.startsWith("delete_")) {
    const index = parseInt(data.split("_")[1]);
    const list = getTaskList(chatId);
    if (list[index]) {
      const removed = list.splice(index, 1);
      bot.sendMessage(chatId, `🗑 Deleted: ${removed[0].task}`);
    }
    return mainMenu(chatId);
  }

  if (data.startsWith("edit_")) {
    const index = parseInt(data.split("_")[1]);
    userStates[chatId] = { mode: "edit", index };
    return bot.sendMessage(chatId, "✍️ Send new text for this task:");
  }

  if (data === "set_morning" || data === "set_evening") {
    const type = data === "set_morning" ? "morning" : "evening";
    return sendTimePicker(chatId, type);
  }

  if (data.startsWith("time_")) {
    const [_, type, time] = data.split("_");
    if (!reminderTimes[chatId]) reminderTimes[chatId] = {};
    reminderTimes[chatId][type] = time;
    scheduleUserReminder(chatId, type, time);
    bot.sendMessage(chatId, `✅ ${type === "morning" ? "Morning" : "Evening"} reminder set for ${time}`);
    return mainMenu(chatId);
  }
});

// --- Time Picker Helper ---
function sendTimePicker(chatId, type) {
  const hours = type === "morning"
    ? ["06:00", "07:00", "08:00", "09:00", "10:00", "11:00"]
    : ["16:00", "17:00", "18:00", "19:00", "20:00", "21:00"];
  const buttons = hours.map((h) => [{ text: h, callback_data: `time_${type}_${h}` }]);
  bot.sendMessage(chatId, `🕒 Choose ${type} reminder time:`, {
    reply_markup: { inline_keyboard: buttons },
  });
}

// --- Schedule Individual User Reminders ---
function scheduleUserReminder(chatId, type, time) {
  if (!reminderJobs[chatId]) reminderJobs[chatId] = {};
  if (reminderJobs[chatId][type]) reminderJobs[chatId][type].stop();

  const [hour, minute] = time.split(":");
  reminderJobs[chatId][type] = cron.schedule(`${minute} ${hour} * * *`, async () => {
    const pending = getTaskList(chatId).filter((t) => !t.done);
    if (pending.length > 0) {
      const list = pending.map((t) => `⏳ ${t.task}`).join("\n");
      await bot.sendMessage(chatId, `🔔 ${type === "morning" ? "Morning" : "Evening"} Reminder:\n${list}`);
    }
  }, { timezone: "Asia/Kolkata" });
}

// --- Weekly Summary (Friday 4 PM) ---
cron.schedule("0 16 * * FRI", async () => {
  for (const [chatId, userTasks] of Object.entries(tasks)) {
    const done = userTasks.filter((t) => t.done);
    const message =
      done.length > 0
        ? `📊 Weekly Summary:\n${done.map((t) => `✅ ${t.task}`).join("\n")}`
        : "📊 Weekly Summary: No tasks completed this week.";
    await bot.sendMessage(chatId, message);
  }
}, { timezone: "Asia/Kolkata" });

// --- Keep Alive for Render ---
const app = express();
app.get("/", (req, res) => res.send("✅ Telegram Task Bot is running!"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web service running on port ${PORT}`));

const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(async () => {
  try {
    const res = await fetch(SELF_URL);
    console.log(`🔄 Keep-alive ping: ${res.status} at ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error("⚠️ Keep-alive ping failed:", err.message);
  }
}, 5 * 60 * 1000);

console.log("✅ Task Bot with Menu, Pagination, Dynamic Reminders & Keep-Alive is running...");
