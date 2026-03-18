import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import express from "express";
import fetch from "node-fetch";

const TOKEN    = process.env.BOT_TOKEN;
const GROQ_KEY = process.env.GROQ_API_KEY;
const PORT     = process.env.PORT || 3000;
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const bot = new TelegramBot(TOKEN, { polling: true });

// ── In-Memory State ─────────────────────────────────────
let tasks         = {}; // { chatId: [{task, done, addedAt}] }
let userStates    = {}; // { chatId: {mode, index, type} }
let reminderTimes = {}; // { chatId: {morning: "HH:mm", evening: "HH:mm"} }
let reminderJobs  = {}; // { chatId: {morning, evening} } cron handles
let deletedTasks  = {}; // { chatId: {task, index, expiresAt} }
let llmHistory    = {}; // { chatId: [{role, content}] } short conversation memory

// ── Helpers ─────────────────────────────────────────────
const PAGE_SIZE = 5;

function getTaskList(chatId) {
  if (!tasks[chatId]) tasks[chatId] = [];
  return tasks[chatId];
}
function clearState(chatId) { delete userStates[chatId]; }
function setState(chatId, s) { userStates[chatId] = s; }

function taskSummary(chatId) {
  const list = getTaskList(chatId);
  const done = list.filter(t => t.done).length;
  const pending = list.length - done;
  if (!list.length) return "📭 No tasks yet";
  return `📋 *${pending}* pending  ·  ✅ *${done}* done`;
}

function buildProgressBar(pct) {
  const f = Math.round(pct / 10);
  return "█".repeat(f) + "░".repeat(10 - f);
}

function paginate(arr, page) {
  const total = Math.ceil(arr.length / PAGE_SIZE) || 1;
  const safe  = Math.min(page, total - 1);
  return { slice: arr.slice(safe * PAGE_SIZE, (safe + 1) * PAGE_SIZE), total, safe };
}

function fmtTaskList(chatId) {
  const list = getTaskList(chatId);
  if (!list.length) return "No tasks.";
  return list.map((t, i) =>
    `${i + 1}. ${t.done ? "✅" : "⏳"} ${t.task}`
  ).join("\n");
}

// ── Main Menu ────────────────────────────────────────────
function mainMenu(chatId, msg = "") {
  const summary = taskSummary(chatId);
  const text = msg ? `${msg}\n\n${summary}` : summary;
  bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      keyboard: [
        ["➕ Add Task", "✅ Mark Done"],
        ["✏️ Edit Task", "🗑 Delete Task"],
        ["📜 Show Tasks", "⏰ Set Reminder"],
        ["📊 Summary",   "❓ Help"],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  });
}

// ════════════════════════════════════════════════════════
//  GROQ LLM LAYER
// ════════════════════════════════════════════════════════

// System prompt — tells the LLM what it can do and how to respond
function buildSystemPrompt(chatId) {
  const list = getTaskList(chatId);
  const taskLines = list.length
    ? list.map((t, i) => `${i + 1}. [${t.done ? "DONE" : "PENDING"}] ${t.task}`).join("\n")
    : "No tasks yet.";

  const reminders = reminderTimes[chatId] || {};
  const reminderLine = Object.entries(reminders)
    .map(([type, time]) => `${type}: ${time}`)
    .join(", ") || "none set";

  return `You are a smart task management assistant embedded in a Telegram bot.

CURRENT DATE/TIME: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST

USER'S TASK LIST:
${taskLines}

USER'S REMINDERS: ${reminderLine}

YOUR JOB:
Understand what the user wants and return a JSON object. Never return plain text — always JSON.

SUPPORTED ACTIONS:
- add        → add a new task
- done       → mark a task complete (by description or number)
- delete     → delete a task (by description or number)
- find       → find/show tasks matching a description
- remind     → set a reminder (morning or evening, with a time)
- summary    → show task summary
- unknown    → you don't understand or it's a general question

RESPONSE FORMAT (strict JSON, no markdown, no extra text):
{
  "action": "add|done|delete|find|remind|summary|unknown",
  "task_text": "exact task text for add action",
  "task_ref": "description or number the user gave to identify a task",
  "matched_index": <0-based index of best matching task, or null>,
  "reminder_type": "morning|evening|null",
  "reminder_time": "HH:MM or null",
  "reply": "friendly confirmation message to send back to user",
  "confidence": "high|medium|low"
}

MATCHING RULES:
- For done/delete: find the best matching task index (0-based) from the task list above
- For remind: extract time from natural language ("tomorrow 9am" → "09:00", "evening" → default "18:00")
- If confidence is low, set action to "unknown" and ask for clarification in reply

EXAMPLES:
User: "add call Priya about survey data"
→ {"action":"add","task_text":"Call Priya about survey data","reply":"✅ Added: Call Priya about survey data","confidence":"high",...}

User: "mark the survey task done"
→ {"action":"done","task_ref":"survey","matched_index":2,"reply":"✅ Marked done: Review survey data","confidence":"high",...}

User: "remind me every morning at 8"
→ {"action":"remind","reminder_type":"morning","reminder_time":"08:00","reply":"⏰ Morning reminder set for 08:00","confidence":"high",...}

User: "what tasks do I have about the report?"
→ {"action":"find","task_ref":"report","reply":"Here are tasks related to report:","confidence":"high",...}`;
}

// Call Groq API
async function callGroq(chatId, userMessage) {
  if (!GROQ_KEY) throw new Error("GROQ_API_KEY not set");

  // Keep last 6 messages for context (short memory)
  if (!llmHistory[chatId]) llmHistory[chatId] = [];
  llmHistory[chatId].push({ role: "user", content: userMessage });
  if (llmHistory[chatId].length > 6) llmHistory[chatId] = llmHistory[chatId].slice(-6);

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_KEY}`,
    },
    body: JSON.stringify({
      model: "llama3-70b-8192",
      temperature: 0.1,          // Low temp = consistent JSON
      max_tokens: 400,
      messages: [
        { role: "system", content: buildSystemPrompt(chatId) },
        ...llmHistory[chatId],
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const raw = data.choices[0]?.message?.content?.trim();

  // Add assistant reply to history
  llmHistory[chatId].push({ role: "assistant", content: raw });

  // Parse JSON — strip markdown fences if model misbehaves
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(cleaned);
}

// Execute the parsed LLM intent
async function executeLLMIntent(chatId, intent) {
  const list = getTaskList(chatId);

  // ── ADD ──────────────────────────────────────────
  if (intent.action === "add" && intent.task_text) {
    const trimmed = intent.task_text.trim();
    list.push({ task: trimmed, done: false, addedAt: Date.now() });
    return mainMenu(chatId, `✅ Added: *${trimmed}*`);
  }

  // ── DONE ─────────────────────────────────────────
  if (intent.action === "done") {
    const idx = resolveIndex(list, intent);
    if (idx === null) {
      return bot.sendMessage(chatId,
        `🤔 Couldn't find a matching task for: _"${intent.task_ref}"_\n\nTry: ✅ Mark Done from the menu to pick manually.`,
        { parse_mode: "Markdown" }
      );
    }
    if (list[idx].done) {
      return bot.sendMessage(chatId, `ℹ️ *${list[idx].task}* is already done.`, { parse_mode: "Markdown" });
    }
    list[idx].done = true;
    return mainMenu(chatId, `✅ Marked done: *${list[idx].task}*`);
  }

  // ── DELETE ───────────────────────────────────────
  if (intent.action === "delete") {
    const idx = resolveIndex(list, intent);
    if (idx === null) {
      return bot.sendMessage(chatId,
        `🤔 Couldn't find a matching task for: _"${intent.task_ref}"_\n\nTry: 🗑 Delete Task from the menu.`,
        { parse_mode: "Markdown" }
      );
    }
    const [removed] = list.splice(idx, 1);
    deletedTasks[chatId] = { task: removed, index: idx, expiresAt: Date.now() + 30_000 };
    bot.sendMessage(chatId,
      `🗑 Deleted: *${removed.task}*\n\n${taskSummary(chatId)}`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "↩️ Undo (30s)", callback_data: "undo_delete" }]],
        },
      }
    );
    return;
  }

  // ── FIND ─────────────────────────────────────────
  if (intent.action === "find") {
    const query = (intent.task_ref || "").toLowerCase();
    const matches = list
      .map((t, i) => ({ ...t, i }))
      .filter(t => t.task.toLowerCase().includes(query));

    if (!matches.length) {
      return bot.sendMessage(chatId,
        `🔍 No tasks found matching: _"${intent.task_ref}"_`,
        { parse_mode: "Markdown" }
      );
    }
    const lines = matches
      .map(t => `${t.i + 1}. ${t.done ? "✅" : "⏳"} ${t.task}`)
      .join("\n");
    return bot.sendMessage(chatId,
      `🔍 *Found ${matches.length} task${matches.length > 1 ? "s" : ""}:*\n\n${lines}`,
      { parse_mode: "Markdown" }
    );
  }

  // ── REMIND ───────────────────────────────────────
  if (intent.action === "remind" && intent.reminder_type && intent.reminder_time) {
    const type = intent.reminder_type;
    const time = intent.reminder_time;
    if (!reminderTimes[chatId]) reminderTimes[chatId] = {};
    reminderTimes[chatId][type] = time;
    scheduleUserReminder(chatId, type, time);
    return mainMenu(chatId, `⏰ ${type === "morning" ? "🌅 Morning" : "🌆 Evening"} reminder set for *${time}*`);
  }

  // ── SUMMARY ──────────────────────────────────────
  if (intent.action === "summary") {
    return sendSummary(chatId);
  }

  // ── UNKNOWN / fallback ───────────────────────────
  const reply = intent.reply || "🤔 I'm not sure what you meant. Use the menu buttons or try rephrasing.";
  return bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
}

// Resolve a task index from LLM output (prefer matched_index, fallback to search)
function resolveIndex(list, intent) {
  // LLM gave us a direct index
  if (intent.matched_index !== null && intent.matched_index !== undefined) {
    const i = parseInt(intent.matched_index);
    if (!isNaN(i) && i >= 0 && i < list.length) return i;
  }
  // Fallback: fuzzy match on task_ref
  if (intent.task_ref) {
    const q = intent.task_ref.toLowerCase();
    // Try exact number
    const num = parseInt(intent.task_ref);
    if (!isNaN(num) && num >= 1 && num <= list.length) return num - 1;
    // Try substring match
    const idx = list.findIndex(t => t.task.toLowerCase().includes(q));
    if (idx !== -1) return idx;
  }
  return null;
}

// ── LLM handler — the main entry point for free text ──
async function handleLLM(chatId, text) {
  // Show typing indicator
  bot.sendChatAction(chatId, "typing");

  try {
    const intent = await callGroq(chatId, text);
    console.log(`🤖 [${chatId}] LLM intent:`, JSON.stringify(intent));

    // Low confidence — tell user
    if (intent.confidence === "low") {
      return bot.sendMessage(chatId,
        `🤔 ${intent.reply || "I'm not sure what you meant."}\n\nOr use the menu buttons below.`,
        { parse_mode: "Markdown" }
      );
    }

    await executeLLMIntent(chatId, intent);

  } catch (err) {
    console.error("LLM error:", err.message);
    bot.sendMessage(chatId,
      "⚠️ Couldn't process that right now. Use the menu buttons or try again.",
      { parse_mode: "Markdown" }
    );
  }
}

// ════════════════════════════════════════════════════════
//  BOT COMMANDS & MENU
// ════════════════════════════════════════════════════════

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from?.first_name || "there";
  clearState(chatId);
  bot.sendMessage(chatId,
    `👋 Hi *${name}*! I'm your AI-powered Task Bot.\n\n` +
    `You can use the *menu buttons* below, or just *type naturally*:\n\n` +
    `_"add call Priya about the report"_\n` +
    `_"mark the survey task done"_\n` +
    `_"remind me every morning at 8"_\n` +
    `_"find tasks about the budget"_`,
    { parse_mode: "Markdown" }
  );
  mainMenu(chatId);
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, HELP_TEXT, { parse_mode: "Markdown" });
});

bot.onText(/\/cancel/, (msg) => {
  clearState(msg.chat.id);
  mainMenu(msg.chat.id, "❌ Cancelled.");
});

bot.onText(/\/clear/, (msg) => {
  const chatId = msg.chat.id;
  const list = getTaskList(chatId);
  const before = list.length;
  tasks[chatId] = list.filter(t => !t.done);
  mainMenu(chatId, `🧹 Cleared ${before - tasks[chatId].length} completed tasks.`);
});

bot.onText(/\/reset/, (msg) => {
  bot.sendMessage(msg.chat.id, "⚠️ Delete ALL tasks?", {
    reply_markup: {
      inline_keyboard: [[
        { text: "Yes, reset", callback_data: "confirm_reset" },
        { text: "Cancel",     callback_data: "cancel_reset"  },
      ]],
    },
  });
});

const HELP_TEXT = `
*📖 Task Bot — AI Edition*

*Natural language (just type!):*
• _"add pick up files from district office"_
• _"mark the Priya task as done"_
• _"delete the old survey task"_
• _"remind me every morning at 8:30"_
• _"find tasks about the budget"_

*Menu buttons:*
➕ Add · ✅ Mark Done · ✏️ Edit · 🗑 Delete
📜 Show · ⏰ Reminder · 📊 Summary

*Commands:*
/cancel · /clear · /reset · /help
`.trim();

// ════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ════════════════════════════════════════════════════════

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text   = msg.text;
  if (!text || text.startsWith("/")) return;

  const state = userStates[chatId];

  // ── Active input states (menu-driven flows) ──────────
  if (state?.mode === "add") {
    const trimmed = text.trim();
    if (!trimmed) return bot.sendMessage(chatId, "⚠️ Task can't be empty. Try again:");
    getTaskList(chatId).push({ task: trimmed, done: false, addedAt: Date.now() });
    clearState(chatId);
    return mainMenu(chatId, `✅ Added: *${trimmed}*`);
  }

  if (state?.mode === "edit") {
    const trimmed = text.trim();
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

  if (state?.mode === "custom_time") {
    const timeRegex = /^([01]?\d|2[0-3]):([0-5]\d)$/;
    if (!timeRegex.test(text.trim())) {
      return bot.sendMessage(chatId, "⚠️ Send time as *HH:MM* (e.g. 08:30):", { parse_mode: "Markdown" });
    }
    if (!reminderTimes[chatId]) reminderTimes[chatId] = {};
    reminderTimes[chatId][state.type] = text.trim();
    scheduleUserReminder(chatId, state.type, text.trim());
    clearState(chatId);
    return mainMenu(chatId, `⏰ Reminder set for *${text.trim()}*`);
  }

  // ── Menu buttons ─────────────────────────────────────
  const menuActions = {
    "➕ Add Task":    () => { setState(chatId, { mode: "add" }); bot.sendMessage(chatId, "✍️ What's the task? (or /cancel)"); },
    "✅ Mark Done":  () => { const l = getTaskList(chatId).filter(t => !t.done); if (!l.length) return mainMenu(chatId, "🎉 All done!"); sendPaginatedTasks(chatId, getTaskList(chatId).filter(t=>!t.done), "done", 0, "✅ Which task did you complete?"); },
    "✏️ Edit Task":  () => { const l = getTaskList(chatId); if (!l.length) return mainMenu(chatId, "📭 No tasks."); sendPaginatedTasks(chatId, l, "edit", 0, "✏️ Which task to edit?"); },
    "🗑 Delete Task": () => { const l = getTaskList(chatId); if (!l.length) return mainMenu(chatId, "📭 No tasks."); sendPaginatedTasks(chatId, l, "delete", 0, "🗑 Which task to delete?"); },
    "📜 Show Tasks": () => { const l = getTaskList(chatId); if (!l.length) return mainMenu(chatId, "📭 No tasks yet!"); sendPaginatedTasks(chatId, l, "show", 0, "📋 Your tasks:"); },
    "⏰ Set Reminder": () => {
      const cur = reminderTimes[chatId] || {};
      bot.sendMessage(chatId, "Which reminder?", {
        reply_markup: { inline_keyboard: [
          [{ text: cur.morning ? `🌅 Morning (${cur.morning})` : "🌅 Set Morning", callback_data: "set_morning" }],
          [{ text: cur.evening ? `🌆 Evening (${cur.evening})` : "🌆 Set Evening", callback_data: "set_evening" }],
        ]},
      });
    },
    "📊 Summary":    () => sendSummary(chatId),
    "❓ Help":       () => bot.sendMessage(chatId, HELP_TEXT, { parse_mode: "Markdown" }),
  };

  if (menuActions[text]) return menuActions[text]();

  // ── FREE TEXT → LLM ──────────────────────────────────
  // Anything that isn't a menu button or active state goes to LLM
  return handleLLM(chatId, text);
});

// ════════════════════════════════════════════════════════
//  PAGINATED TASK DISPLAY
// ════════════════════════════════════════════════════════

function sendPaginatedTasks(chatId, list, action, page = 0, header = "📋 Tasks:") {
  const { slice, total, safe } = paginate(list, page);

  const icons = { show: t => t.done ? "✅" : "⏳", done: () => "⏳", delete: () => "🗑", edit: () => "✏️" };

  const buttons = slice.map((t, i) => [{
    text: `${icons[action](t)} ${t.task}`,
    callback_data: `${action}|${safe * PAGE_SIZE + i}`,
  }]);

  if (total > 1) {
    const nav = [];
    if (safe > 0)         nav.push({ text: "⬅ Prev", callback_data: `page|${action}|${safe - 1}` });
    nav.push({ text: `${safe + 1}/${total}`, callback_data: "noop" });
    if (safe < total - 1) nav.push({ text: "Next ➡", callback_data: `page|${action}|${safe + 1}` });
    buttons.push(nav);
  }

  buttons.push([{ text: "🔙 Back", callback_data: "back_menu" }]);

  bot.sendMessage(chatId, header, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons },
  });
}

// ════════════════════════════════════════════════════════
//  CALLBACK QUERY HANDLER
// ════════════════════════════════════════════════════════

bot.on("callback_query", (query) => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const data   = query.data;

  bot.answerCallbackQuery(query.id);

  if (data === "noop") return;

  if (data === "back_menu") {
    bot.deleteMessage(chatId, msgId).catch(() => {});
    clearState(chatId);
    return mainMenu(chatId);
  }

  if (data === "confirm_reset") {
    tasks[chatId] = []; reminderTimes[chatId] = {};
    clearState(chatId);
    bot.deleteMessage(chatId, msgId).catch(() => {});
    return mainMenu(chatId, "🔄 Reset complete.");
  }
  if (data === "cancel_reset") {
    bot.deleteMessage(chatId, msgId).catch(() => {});
    return mainMenu(chatId);
  }

  if (data === "undo_delete") {
    const u = deletedTasks[chatId];
    if (!u || Date.now() > u.expiresAt) {
      return bot.sendMessage(chatId, "⚠️ Undo window expired.");
    }
    getTaskList(chatId).splice(u.index, 0, u.task);
    delete deletedTasks[chatId];
    bot.deleteMessage(chatId, msgId).catch(() => {});
    return mainMenu(chatId, `↩️ Restored: *${u.task.task}*`);
  }

  if (data.startsWith("page|")) {
    const [, action, p] = data.split("|");
    const list = action === "done"
      ? getTaskList(chatId).filter(t => !t.done)
      : getTaskList(chatId);
    bot.deleteMessage(chatId, msgId).catch(() => {});
    return sendPaginatedTasks(chatId, list, action, parseInt(p));
  }

  const [action, idxStr] = data.split("|");
  const index = parseInt(idxStr);
  const list  = getTaskList(chatId);

  if (action === "done") {
    if (list[index] && !list[index].done) list[index].done = true;
    bot.deleteMessage(chatId, msgId).catch(() => {});
    return mainMenu(chatId, `✅ Completed: *${list[index]?.task}*`);
  }

  if (action === "delete") {
    if (list[index]) {
      const [removed] = list.splice(index, 1);
      deletedTasks[chatId] = { task: removed, index, expiresAt: Date.now() + 30_000 };
      bot.deleteMessage(chatId, msgId).catch(() => {});
      bot.sendMessage(chatId, `🗑 Deleted: *${removed.task}*\n${taskSummary(chatId)}`, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "↩️ Undo (30s)", callback_data: "undo_delete" }]] },
      });
    }
    return;
  }

  if (action === "edit") {
    if (list[index]) {
      setState(chatId, { mode: "edit", index });
      bot.deleteMessage(chatId, msgId).catch(() => {});
      bot.sendMessage(chatId,
        `✏️ Current: _${list[index].task}_\n\nSend new text: (or /cancel)`,
        { parse_mode: "Markdown" }
      );
    }
    return;
  }

  if (data === "set_morning" || data === "set_evening") {
    const type = data === "set_morning" ? "morning" : "evening";
    bot.deleteMessage(chatId, msgId).catch(() => {});
    return sendTimePicker(chatId, type);
  }

  if (data.startsWith("time|")) {
    const [, type, time] = data.split("|");
    if (!reminderTimes[chatId]) reminderTimes[chatId] = {};
    reminderTimes[chatId][type] = time;
    scheduleUserReminder(chatId, type, time);
    bot.deleteMessage(chatId, msgId).catch(() => {});
    return mainMenu(chatId, `⏰ ${type === "morning" ? "🌅" : "🌆"} Reminder set for *${time}*`);
  }

  if (data.startsWith("custom_time|")) {
    const [, type] = data.split("|");
    setState(chatId, { mode: "custom_time", type });
    bot.deleteMessage(chatId, msgId).catch(() => {});
    return bot.sendMessage(chatId, `✍️ Send *${type}* time as HH:MM (e.g. 08:30):`, { parse_mode: "Markdown" });
  }
});

// ════════════════════════════════════════════════════════
//  REMINDER & SUMMARY HELPERS
// ════════════════════════════════════════════════════════

function sendTimePicker(chatId, type) {
  const slots = type === "morning"
    ? ["06:00","07:00","08:00","09:00","10:00","11:00"]
    : ["15:00","16:00","17:00","18:00","19:00","20:00","21:00"];

  const rows = [];
  for (let i = 0; i < slots.length; i += 3) {
    rows.push(slots.slice(i, i + 3).map(h => ({ text: h, callback_data: `time|${type}|${h}` })));
  }
  rows.push([{ text: "✍️ Custom time", callback_data: `custom_time|${type}` }]);
  rows.push([{ text: "🔙 Back", callback_data: "back_menu" }]);

  bot.sendMessage(chatId, `🕒 Choose *${type}* reminder time:`, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: rows },
  });
}

function scheduleUserReminder(chatId, type, time) {
  if (!reminderJobs[chatId]) reminderJobs[chatId] = {};
  if (reminderJobs[chatId][type]) reminderJobs[chatId][type].stop();

  const [h, m] = time.split(":");
  reminderJobs[chatId][type] = cron.schedule(
    `${m} ${h} * * *`,
    async () => {
      const pending = getTaskList(chatId).filter(t => !t.done);
      if (!pending.length) return;
      const emoji = type === "morning" ? "🌅" : "🌆";
      const lines = pending.map((t, i) => `${i + 1}. ⏳ ${t.task}`).join("\n");
      bot.sendMessage(chatId,
        `${emoji} *${type === "morning" ? "Morning" : "Evening"} Reminder*\n\n${lines}`,
        { parse_mode: "Markdown" }
      );
    },
    { timezone: "Asia/Kolkata" }
  );
}

function sendSummary(chatId) {
  const list  = getTaskList(chatId);
  const done  = list.filter(t => t.done).length;
  const total = list.length;
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
  const bar   = buildProgressBar(pct);
  const rem   = reminderTimes[chatId];
  const remLine = rem
    ? `⏰ ${rem.morning ? `🌅 ${rem.morning}` : ""} ${rem.evening ? `🌆 ${rem.evening}` : ""}`.trim()
    : "⏰ No reminders set";

  bot.sendMessage(chatId,
    `📊 *Your Summary*\n\n${bar} ${pct}%\n📋 Total: ${total} · ⏳ Pending: ${total - done} · ✅ Done: ${done}\n\n${remLine}`,
    { parse_mode: "Markdown" }
  );
}

// ════════════════════════════════════════════════════════
//  CRON & INFRA
// ════════════════════════════════════════════════════════

// Weekly summary — Friday 4 PM IST
cron.schedule("0 16 * * FRI", async () => {
  for (const [chatId, userTasks] of Object.entries(tasks)) {
    const done    = userTasks.filter(t => t.done);
    const pending = userTasks.filter(t => !t.done);
    const total   = userTasks.length;
    const pct     = total > 0 ? Math.round((done.length / total) * 100) : 0;
    const bar     = buildProgressBar(pct);

    let msg = `📊 *Weekly Summary*\n\n${bar} ${pct}% complete\n`;
    if (done.length)    msg += `\n✅ *Done (${done.length}):*\n${done.map(t=>`• ${t.task}`).join("\n")}`;
    if (pending.length) msg += `\n\n⏳ *Pending (${pending.length}):*\n${pending.map(t=>`• ${t.task}`).join("\n")}`;
    if (!total)         msg += "\nNo tasks this week. 💪";

    bot.sendMessage(parseInt(chatId), msg, { parse_mode: "Markdown" });
    tasks[chatId] = userTasks.filter(t => !t.done); // archive
  }
}, { timezone: "Asia/Kolkata" });

// Keep-alive
const app = express();
app.get("/", (req, res) => res.send("✅ Task Bot (AI Edition) running!"));
app.listen(PORT, () => console.log(`🌐 Server on port ${PORT}`));

setInterval(async () => {
  try {
    const r = await fetch(SELF_URL);
    console.log(`🔄 Keep-alive: ${r.status}`);
  } catch (e) {
    console.error("⚠️ Keep-alive failed:", e.message);
  }
}, 5 * 60 * 1000);

console.log("✅ Task Bot (AI Edition) — Groq · llama3-70b · running...");
