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
let deletedTasks = {};   // { chatId: { task, index, expiresAt } } \u2014 for undo

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
  if (list.length === 0) return "\ud83d\udced No tasks yet";
  return `\ud83d\udccb ${pending} pending \u00b7 \u2705 ${done} done`;
}

// --- Main Menu ---
function mainMenu(chatId, extraMsg = null) {
  const summary = taskSummary(chatId);
  const text = extraMsg ? `${extraMsg}\n\n${summary}` : summary;
  bot.sendMessage(chatId, text, {
    reply_markup: {
      keyboard: [
        ["\u2795 Add Task", "\u2705 Mark Done"],
        ["\u270f\ufe0f Edit Task", "\ud83d\uddd1 Delete Task"],
        ["\ud83d\udcdc Show Tasks", "\u23f0 Set Reminder"],
        ["\ud83d\udcca Summary", "\u2753 Help"],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  });
}

// --- Help Text ---
const HELP_TEXT = `
*\ud83d\udcd6 Task Bot \u2014 Quick Guide*

\u2795 *Add Task* \u2014 type a new task
\u2705 *Mark Done* \u2014 mark pending tasks complete
\u270f\ufe0f *Edit Task* \u2014 update any task's text
\ud83d\uddd1 *Delete Task* \u2014 remove a task (with undo!)
\ud83d\udcdc *Show Tasks* \u2014 browse all tasks
\u23f0 *Set Reminder* \u2014 daily morning/evening nudge
\ud83d\udcca *Summary* \u2014 weekly stats

*Tips:*
\u2022 After deleting, tap *Undo* within 30 seconds
\u2022 Done tasks are archived in your weekly summary
\u2022 Use /clear to wipe all completed tasks
\u2022 Use /reset to start fresh
`.trim();

// --- Start & Help ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from?.first_name || "there";
  clearState(chatId);
  bot.sendMessage(chatId, `\ud83d\udc4b Hi *${name}*! I'm your Task Bot. Let's stay productive.`, {
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
  mainMenu(chatId, `\ud83e\uddf9 Cleared ${cleared} completed task${cleared !== 1 ? "s" : ""}.`);
});

bot.onText(/\/reset/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "\u26a0\ufe0f This will delete ALL your tasks. Are you sure?", {
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
    if (!trimmed) return bot.sendMessage(chatId, "\u26a0\ufe0f Task can't be empty. Try again:");
    getTaskList(chatId).push({ task: trimmed, done: false, addedAt: Date.now() });
    clearState(chatId);
    return mainMenu(chatId, `\u2705 Added: *${trimmed}*`);
  }

  // --- State: editing a task ---
  if (state?.mode === "edit") {
    const trimmed = text.trim();
    if (!trimmed) return bot.sendMessage(chatId, "\u26a0\ufe0f Task can't be empty. Try again:");
    const list = getTaskList(chatId);
    if (list[state.index]) {
      const old = list[state.index].task;
      list[state.index].task = trimmed;
      clearState(chatId);
      return mainMenu(chatId, `\u270f\ufe0f Updated: _${old}_ \u2192 *${trimmed}*`);
    }
    clearState(chatId);
    return mainMenu(chatId, "\u26a0\ufe0f Task not found.");
  }

  // --- State: setting custom reminder time ---
  if (state?.mode === "custom_time") {
    const timeRegex = /^([01]?\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(text.trim())) {
      return bot.sendMessage(chatId, "\u26a0\ufe0f Invalid format. Please send time as *HH:MM* (e.g. 08:30):", {
        parse_mode: "Markdown",
      });
    }
    const type = state.type;
    if (!reminderTimes[chatId]) reminderTimes[chatId] = {};
    reminderTimes[chatId][type] = text.trim();
    scheduleUserReminder(chatId, type, text.trim());
    clearState(chatId);
    return mainMenu(chatId, `\u23f0 ${type === "morning" ? "\ud83c\udf05 Morning" : "\ud83c\udf06 Evening"} reminder set for *${text.trim()}*`);
  }

  // --- Menu buttons ---
  if (text === "\u2795 Add Task") {
    clearState(chatId);
    setState(chatId, { mode: "add" });
    return bot.sendMessage(chatId, "\u270d\ufe0f What's the task? (Send /cancel to abort)");
  }

  if (text === "\u2705 Mark Done") {
    const list = getTaskList(chatId).filter((t) => !t.done);
    if (list.length === 0) return mainMenu(chatId, "\ud83c\udf89 All tasks are done!");
    return sendPaginatedTasks(chatId, list, "done", 0, "\u2705 Which task did you complete?");
  }

  if (text === "\u270f\ufe0f Edit Task") {
    const list = getTaskList(chatId);
    if (list.length === 0) return mainMenu(chatId, "\ud83d\udced No tasks to edit.");
    return sendPaginatedTasks(chatId, list, "edit", 0, "\u270f\ufe0f Which task do you want to edit?");
  }

  if (text === "\ud83d\uddd1 Delete Task") {
    const list = getTaskList(chatId);
    if (list.length === 0) return mainMenu(chatId, "\ud83d\udced No tasks to delete.");
    return sendPaginatedTasks(chatId, list, "delete", 0, "\ud83d\uddd1 Which task do you want to delete?");
  }

  if (text === "\ud83d\udcdc Show Tasks") {
    const list = getTaskList(chatId);
    if (list.length === 0) return mainMenu(chatId, "\ud83d\udced No tasks yet. Add one!");
    return sendPaginatedTasks(chatId, list, "show", 0, "\ud83d\udccb Your tasks:");
  }

  if (text === "\u23f0 Set Reminder") {
    const current = reminderTimes[chatId] || {};
    const morningLabel = current.morning ? `\ud83c\udf05 Morning (${current.morning})` : "\ud83c\udf05 Set Morning";
    const eveningLabel = current.evening ? `\ud83c\udf06 Evening (${current.evening})` : "\ud83c\udf06 Set Evening";
    return bot.sendMessage(chatId, "Which reminder do you want to set?", {
      reply_markup: {
        inline_keyboard: [
          [{ text: morningLabel, callback_data: "set_morning" }],
          [{ text: eveningLabel, callback_data: "set_evening" }],
        ],
      },
    });
  }

  if (text === "\ud83d\udcca Summary") {
    return sendSummary(chatId);
  }

  if (text === "\u2753 Help") {
    return bot.sendMessage(chatId, HELP_TEXT, { parse_mode: "Markdown" });
  }
});

bot.onText(/\/cancel/, (msg) => {
  clearState(msg.chat.id);
  mainMenu(msg.chat.id, "\u274c Cancelled.");
});

// --- Paginated Task Display ---
function sendPaginatedTasks(chatId, list, action, page = 0, header = "\ud83d\udccb Tasks:") {
  const { slice, totalPages, safePage } = paginate(list, PAGE_SIZE, page);

  const buttons = slice.map((t, i) => {
    const index = safePage * PAGE_SIZE + i;
    let label;
    if (action === "show") {
      label = `${t.done ? "\u2705" : "\u23f3"} ${t.task}`;
    } else if (action === "done") {
      label = `\u23f3 ${t.task}`;
    } else if (action === "delete") {
      label = `\ud83d\uddd1 ${t.task}`;
    } else {
      label = `\u270f\ufe0f ${t.task}`;
    }
    return [{ text: label, callback_data: `${action}|${index}` }];
  });

  // Navigation row
  if (totalPages > 1) {
    const nav = [];
    if (safePage > 0) nav.push({ text: "\u2b05 Prev", callback_data: `page|${action}|${safePage - 1}` });
    nav.push({ text: `${safePage + 1}/${totalPages}`, callback_data: "noop" });
    if (safePage < totalPages - 1) nav.push({ text: "Next \u27a1", callback_data: `page|${action}|${safePage + 1}` });
    buttons.push(nav);
  }

  // Cancel row
  buttons.push([{ text: "\ud83d\udd19 Back to Menu", callback_data: "back_menu" }]);

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
    ? `\u23f0 Reminders: ${reminder.morning ? `\ud83c\udf05 ${reminder.morning}` : ""} ${reminder.evening ? `\ud83c\udf06 ${reminder.evening}` : ""}`.trim()
    : "\u23f0 No reminders set";

  const msg = `
\ud83d\udcca *Your Task Summary*

${bar} ${pct}%
\ud83d\udccb Total: ${total}  \u00b7  \u23f3 Pending: ${pending}  \u00b7  \u2705 Done: ${done}

${reminderLine}
  `.trim();

  bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
}

function buildProgressBar(pct) {
  const filled = Math.round(pct / 10);
  return "\u2588".repeat(filled) + "\u2591".repeat(10 - filled);
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
    return mainMenu(chatId, "\ud83d\udd04 All tasks cleared.");
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
      return bot.sendMessage(chatId, "\u26a0\ufe0f Undo window expired.");
    }
    const list = getTaskList(chatId);
    list.splice(undoData.index, 0, undoData.task);
    delete deletedTasks[chatId];
    bot.deleteMessage(chatId, msgId).catch(() => {});
    return mainMenu(chatId, `\u21a9\ufe0f Restored: *${undoData.task.task}*`);
  }

  // Actions: done|INDEX, edit|INDEX, delete|INDEX
  const [action, indexStr] = data.split("|");
  const index = parseInt(indexStr);
  const list = getTaskList(chatId);

  if (action === "done") {
    if (list[index] && !list[index].done) {
      list[index].done = true;
      bot.deleteMessage(chatId, msgId).catch(() => {});
      return mainMenu(chatId, `\u2705 Completed: *${list[index].task}*`);
    }
    return mainMenu(chatId);
  }

  if (action === "delete") {
    if (list[index]) {
      const [removed] = list.splice(index, 1);
      deletedTasks[chatId] = { task: removed, index, expiresAt: Date.now() + 30_000 };
      bot.deleteMessage(chatId, msgId).catch(() => {});
      bot.sendMessage(chatId, `\ud83d\uddd1 Deleted: *${removed.task}*\n${taskSummary(chatId)}`, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "\u21a9\ufe0f Undo (30s)", callback_data: "undo_delete" }]],
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
        `\u270f\ufe0f Current: _${list[index].task}_\n\nSend the new text:
