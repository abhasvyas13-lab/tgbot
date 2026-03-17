import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import express from "express";
import fetch from "node-fetch";

const TOKEN = process.env.BOT_TOKEN || "7674031536:AAEYlgD1ufhYXGIs6nYCxOcD1I1NsFLOqrg";
const bot = new TelegramBot(TOKEN, { polling: true });

// --- Persistent Data ---
let tasks = {};          // { chatId: [ {task, done, addedAt} ] }
let reminderTimes = {};  // { chatId: { morning: "HH:mm", evening: "HH:mm" } }
let reminderJobs = {};   // dynamic cron jobs per user
let deletedTasks = {};   // { chatId: { task, index, expiresAt } } — for undo

function getTaskList(chatId) {
  if (!tasks[chatId]) tasks[chatId] = [];
  return tasks[chatId];
}

// --- User State ---
let userStates = {}; // track add/edit/reminder states

// --- State Management ---
function clearState(chatId) {
  delete userStates[chatId];
}

function setState(chatId, state) {
  userStates[chatId] = state;
}

// --- Pagination Helper ---
const PAGE_SIZE = 5;

function paginate(array, pageSize, page) {
  const totalPages = Math.ceil(array.length / pageSize) || 1;
  const safePage = Math.min(page, totalPages - 1);
  const slice = array.slice(safePage * pageSize, (safePage + 1) * pageSize);
  return { slice, totalPages, safePage };
}

// --- Task Count Summary ---
function taskSummary(chatId) {
  const list = getTaskList(chatId);
  const done = list.filter((t) => t.done).length;
  const pending = list.length - done;
  if (list.length === 0) return "📭 No tasks yet";
  return `📋 ${pending} pending · ✅ ${done} done`;
}

// --- Main Menu ---
function mainMenu(chatId, extraMsg = null) {
  const summary = taskSummary(chatId);
  const text = extraMsg ? `${extraMsg}\n\n${summary}` : summary;
  bot.sendMessage(chatId, text, {
    reply_markup: {
      keyboard: [
        ["➕ Add Task", "✅ Mark Done"],
        ["✏️ Edit Task", "🗑 Delete Task"],
        ["📜 Show Tasks", "⏰ Set Reminder"],
        ["📊 Summary", "❓ Help"],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  });
}

// --- Help Text ---
const HELP_TEXT = `
*📖 Task Bot — Quick Guide*

➕ *Add Task* — type a new task
✅ *Mark Done* — mark pending tasks complete
✏️ *Edit Task* — update any task's text
🗑 *Delete Task* — remove a task (with undo!)
📜 *Show Tasks* — browse all tasks
⏰ *Set Reminder* — daily morning/evening nudge
📊 *Summary* — weekly stats

*Tips:*
• After deleting, tap *Undo* within 30 seconds
• Done tasks are archived in your weekly summary
• Use /clear to wipe all completed tasks
• Use /reset to start fresh
`.trim();

// --- Start & Help ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from?.first_name || "there";
  clearState(chatId);
  bot.sendMessage(chatId, `👋 Hi *${name}*! I'm your Task Bot. Let's stay productive.`, {
    parse_mode: "Markdown",
  });
  mainMenu(chatId);
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: "Markdown" });
});

bot.onText(/\/clear/, (msg) => {
  const chatId = msg.chat.id;
  const list = getTaskList(chatId);
  const before = list.length;
  tasks[chatId] = list.filter((t) => !t.done);
  const cleared = before - tasks[chatId].length;
  mainMenu(chatId, `🧹 Cleared ${cleared} completed task${cleared !== 1 ? "s" : ""}.`);
});

bot.onText(/\/reset/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "⚠️ This will delete ALL your tasks. Are you sure?", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Yes, reset everything", callback_data: "confirm_reset" },
          { text: "Cancel", callback_data: "cancel_reset" },
        ],
      ],
    },
  });
});

// --- Main Message Handler ---
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith("/")) return;

  const state = userStates[chatId];

  // --- State: adding a task ---
  if (state?.mode === "add") {
    const trimmed = text.trim();
    if (!trimmed) return bot.sendMessage(chatId, "⚠️ Task can't be empty. Try again:");
    getTaskList(chatId).push({ task: trimmed, done: false, addedAt: Date.now() });
    clearState(chatId);
    return mainMenu(chatId, `✅ Added: *${trimmed}*`);
  }

  // --- State: editing a task ---
  if (state?.mode === "edit") {
    const trimmed = text.trim();
    if (!trimmed) return bot.sendMessage(chatId, "⚠️ Task can't be empty. Try again:");
    const list = getTaskList(chatId);
    if (list[state.index]) {
      const old = list[state.index].task;
      list[state.index].task = trimmed;
      clearState(chatId);
      return mainMenu(chatId, `✏️ Updated: _${old}_ → *${trimmed}*`);
    }
    clearState(chatId);
    return mainMenu(chatId, "⚠️ Task not found.");
  }

  // --- State: setting custom reminder time ---
  if (state?.mode === "custom_time") {
    const timeRegex = /^([01]?\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(text.trim())) {
      return bot.sendMessage(chatId, "⚠️ Invalid format. Please send time as *HH:MM* (e.g. 08:30):", {
        parse_mode: "Markdown",
      });
    }
    const type = state.type;
    if (!reminderTimes[chatId]) reminderTimes[chatId] = {};
    reminderTimes[chatId][type] = text.trim();
    scheduleUserReminder(chatId, type, text.trim());
    clearState(chatId);
    return mainMenu(chatId, `⏰ ${type === "morning" ? "🌅 Morning" : "🌆 Evening"} reminder set for *${text.trim()}*`);
  }

  // --- Menu buttons ---
  if (text === "➕ Add Task") {
    clearState(chatId);
    setState(chatId, { mode: "add" });
    return bot.sendMessage(chatId, "✍️ What's the task? (Send /cancel to abort)");
  }

  if (text === "✅ Mark Done") {
    const list = getTaskList(chatId).filter((t) => !t.done);
    if (list.length === 0) return mainMenu(chatId, "🎉 All tasks are done!");
    return sendPaginatedTasks(chatId, list, "done", 0, "✅ Which task did you complete?");
  }

  if (text === "✏️ Edit Task") {
    const list = getTaskList(chatId);
    if (list.length === 0) return mainMenu(chatId, "📭 No tasks to edit.");
    return sendPaginatedTasks(chatId, list, "edit", 0, "✏️ Which task do you want to edit?");
  }

  if (text === "🗑 Delete Task") {
    const list = getTaskList(chatId);
    if (list.length === 0) return mainMenu(chatId, "📭 No tasks to delete.");
    return sendPaginatedTasks(chatId, list, "delete", 0, "🗑 Which task do you want to delete?");
  }

  if (text === "📜 Show Tasks") {
    const list = getTaskList(chatId);
    if (list.length === 0) return mainMenu(chatId, "📭 No tasks yet. Add one!");
    return sendPaginatedTasks(chatId, list, "show", 0, "📋 Your tasks:");
  }

  if (text === "⏰ Set Reminder") {
    const current = reminderTimes[chatId] || {};
    const morningLabel = current.morning ? `🌅 Morning (${current.morning})` : "🌅 Set Morning";
    const eveningLabel = current.evening ? `🌆 Evening (${current.evening})` : "🌆 Set Evening";
    return bot.sendMessage(chatId, "Which reminder do you want to set?", {
      reply_markup: {
        inline_keyboard: [
          [{ text: morningLabel, callback_data: "set_morning" }],
          [{ text: eveningLabel, callback_data: "set_evening" }],
        ],
      },
    });
  }

  if (text === "📊 Summary") {
    return sendSummary(chatId);
  }

  if (text === "❓ Help") {
    return bot.sendMessage(chatId, HELP_TEXT, { parse_mode: "Markdown" });
  }
});

bot.onText(/\/cancel/, (msg) => {
  clearState(msg.chat.id);
  mainMenu(msg.chat.id, "❌ Cancelled.");
});

// --- Paginated Task Display ---
function sendPaginatedTasks(chatId, list, action, page = 0, header = "📋 Tasks:") {
  const { slice, totalPages, safePage } = paginate(list, PAGE_SIZE, page);

  const buttons = slice.map((t, i) => {
    const index = safePage * PAGE_SIZE + i;
    let label;
    if (action === "show") {
      label = `${t.done ? "✅" : "⏳"} ${t.task}`;
    } else if (action === "done") {
      label = `⏳ ${t.task}`;
    } else if (action === "delete") {
      label = `🗑 ${t.task}`;
    } else {
      label = `✏️ ${t.task}`;
    }
    return [{ text: label, callback_data: `${action}|${index}` }];
  });

  // Navigation row
  if (totalPages > 1) {
    const nav = [];
    if (safePage > 0) nav.push({ text: "⬅ Prev", callback_data: `page|${action}|${safePage - 1}` });
    nav.push({ text: `${safePage + 1}/${totalPages}`, callback_data: "noop" });
    if (safePage < totalPages - 1) nav.push({ text: "Next ➡", callback_data: `page|${action}|${safePage + 1}` });
    buttons.push(nav);
  }

  // Cancel row
  buttons.push([{ text: "🔙 Back to Menu", callback_data: "back_menu" }]);

  bot.sendMessage(chatId, header, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons },
  });
}

// --- Summary ---
function sendSummary(chatId) {
  const list = getTaskList(chatId);
  const total = list.length;
  const done = list.filter((t) => t.done).length;
  const pending = total - done;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const bar = buildProgressBar(pct);
  const reminder = reminderTimes[chatId];
  const reminderLine = reminder
    ? `⏰ Reminders: ${reminder.morning ? `🌅 ${reminder.morning}` : ""} ${reminder.evening ? `🌆 ${reminder.evening}` : ""}`.trim()
    : "⏰ No reminders set";

  const msg = `
📊 *Your Task Summary*

${bar} ${pct}%
📋 Total: ${total}  ·  ⏳ Pending: ${pending}  ·  ✅ Done: ${done}

${reminderLine}
  `.trim();

  bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
}

function buildProgressBar(pct) {
  const filled = Math.round(pct / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

// --- Callback Query Handler ---
bot.on("callback_query", (query) => {
  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;
  const data = query.data;

  bot.answerCallbackQuery(query.id); // always acknowledge

  // Noop (page indicator button)
  if (data === "noop") return;

  // Back to menu
  if (data === "back_menu") {
    bot.deleteMessage(chatId, msgId).catch(() => {});
    clearState(chatId);
    return mainMenu(chatId);
  }

  // Reset confirmation
  if (data === "confirm_reset") {
    tasks[chatId] = [];
    reminderTimes[chatId] = {};
    clearState(chatId);
    bot.deleteMessage(chatId, msgId).catch(() => {});
    return mainMenu(chatId, "🔄 All tasks cleared.");
  }
  if (data === "cancel_reset") {
    bot.deleteMessage(chatId, msgId).catch(() => {});
    return mainMenu(chatId);
  }

  // Pagination
  if (data.startsWith("page|")) {
    const [, action, page] = data.split("|");
    const list = action === "done"
      ? getTaskList(chatId).filter((t) => !t.done)
      : getTaskList(chatId);
    bot.deleteMessage(chatId, msgId).catch(() => {});
    return sendPaginatedTasks(chatId, list, action, parseInt(page));
  }

  // Undo delete
  if (data === "undo_delete") {
    const undoData = deletedTasks[chatId];
    if (!undoData || Date.now() > undoData.expiresAt) {
      return bot.sendMessage(chatId, "⚠️ Undo window expired.");
    }
    const list = getTaskList(chatId);
    list.splice(undoData.index, 0, undoData.task);
    delete deletedTasks[chatId];
    bot.deleteMessage(chatId, msgId).catch(() => {});
    return mainMenu(chatId, `↩️ Restored: *${undoData.task.task}*`);
  }

  // Actions: done|INDEX, edit|INDEX, delete|INDEX
  const [action, indexStr] = data.split("|");
  const index = parseInt(indexStr);
  const list = getTaskList(chatId);

  if (action === "done") {
    if (list[index] && !list[index].done) {
      list[index].done = true;
      bot.deleteMessage(chatId, msgId).catch(() => {});
      return mainMenu(chatId, `✅ Completed: *${list[index].task}*`);
    }
    return mainMenu(chatId);
  }

  if (action === "delete") {
    if (list[index]) {
      const [removed] = list.splice(index, 1);
      deletedTasks[chatId] = { task: removed, index, expiresAt: Date.now() + 30_000 };
      bot.deleteMessage(chatId, msgId).catch(() => {});
      bot.sendMessage(chatId, `🗑 Deleted: *${removed.task}*\n${taskSummary(chatId)}`, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "↩️ Undo (30s)", callback_data: "undo_delete" }]],
        },
      });
      return;
    }
    return mainMenu(chatId);
  }

  if (action === "edit") {
    if (list[index]) {
      setState(chatId, { mode: "edit", index });
      bot.deleteMessage(chatId, msgId).catch(() => {});
      return bot.sendMessage(
        chatId,
        `✏️ Current: _${list[index].task}_\n\nSend the new text: (or /cancel)`,
        { parse_mode: "Markdown" }
      );
    }
    return mainMenu(chatId);
  }

  // Reminder type selection
  if (data === "set_morning" || data === "set_evening") {
    const type = data === "set_morning" ? "morning" : "evening";
    bot.deleteMessage(chatId, msgId).catch(() => {});
    return sendTimePicker(chatId, type);
  }

  // Reminder time selection
  if (data.startsWith("time|")) {
    const [, type, time] = data.split("|");
    if (!reminderTimes[chatId]) reminderTimes[chatId] = {};
    reminderTimes[chatId][type] = time;
    scheduleUserReminder(chatId, type, time);
    bot.deleteMessage(chatId, msgId).catch(() => {});
    return mainMenu(chatId, `⏰ ${type === "morning" ? "🌅 Morning" : "🌆 Evening"} reminder set for *${time}*`);
  }

  // Custom time trigger
  if (data.startsWith("custom_time|")) {
    const [, type] = data.split("|");
    setState(chatId, { mode: "custom_time", type });
    bot.deleteMessage(chatId, msgId).catch(() => {});
    return bot.sendMessage(chatId, `✍️ Send your preferred *${type}* time in HH:MM format (e.g. 08:30):`, {
      parse_mode: "Markdown",
    });
  }
});

// --- Time Picker ---
function sendTimePicker(chatId, type) {
  const slots =
    type === "morning"
      ? ["06:00", "07:00", "08:00", "09:00", "10:00", "11:00"]
      : ["15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00"];

  // Group into rows of 3
  const rows = [];
  for (let i = 0; i < slots.length; i += 3) {
    rows.push(
      slots.slice(i, i + 3).map((h) => ({ text: h, callback_data: `time|${type}|${h}` }))
    );
  }
  rows.push([{ text: "✍️ Custom time", callback_data: `custom_time|${type}` }]);
  rows.push([{ text: "🔙 Back", callback_data: "back_menu" }]);

  bot.sendMessage(chatId, `🕒 Choose your *${type}* reminder time:`, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows },
  });
}

// --- Schedule Individual Reminders ---
function scheduleUserReminder(chatId, type, time) {
  if (!reminderJobs[chatId]) reminderJobs[chatId] = {};
  if (reminderJobs[chatId][type]) reminderJobs[chatId][type].stop();

  const [hour, minute] = time.split(":");
  reminderJobs[chatId][type] = cron.schedule(
    `${minute} ${hour} * * *`,
    async () => {
      const pending = getTaskList(chatId).filter((t) => !t.done);
      if (pending.length === 0) return;
      const emoji = type === "morning" ? "🌅" : "🌆";
      const list = pending.map((t, i) => `${i + 1}. ⏳ ${t.task}`).join("\n");
      await bot.sendMessage(
        chatId,
        `${emoji} *${type === "morning" ? "Morning" : "Evening"} Reminder*\n\nYou have ${pending.length} pending task${pending.length !== 1 ? "s" : ""}:\n\n${list}`,
        { parse_mode: "Markdown" }
      );
    },
    { timezone: "Asia/Kolkata" }
  );
}

// --- Weekly Summary (Friday 4 PM IST) ---
cron.schedule(
  "0 16 * * FRI",
  async () => {
    for (const [chatId, userTasks] of Object.entries(tasks)) {
      const done = userTasks.filter((t) => t.done);
      const pending = userTasks.filter((t) => !t.done);
      const total = userTasks.length;
      const pct = total > 0 ? Math.round((done.length / total) * 100) : 0;
      const bar = buildProgressBar(pct);

      let msg = `📊 *Weekly Summary*\n\n${bar} ${pct}% complete\n`;
      if (done.length > 0) {
        msg += `\n✅ *Completed (${done.length}):*\n${done.map((t) => `• ${t.task}`).join("\n")}`;
      }
      if (pending.length > 0) {
        msg += `\n\n⏳ *Still pending (${pending.length}):*\n${pending.map((t) => `• ${t.task}`).join("\n")}`;
      }
      if (total === 0) msg += "\nNo tasks this week. Start fresh! 💪";

      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });

      // Auto-archive completed tasks after weekly summary
      tasks[chatId] = userTasks.filter((t) => !t.done);
    }
  },
  { timezone: "Asia/Kolkata" }
);

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

console.log("✅ Task Bot running — Menu + Pagination + Reminders + Undo + Progress");
