// The natural-language brain. Turns a plain-English Telegram message into
// actions on the schedule, via Claude tool use. Uses claude-opus-4-8.

const Anthropic = require('@anthropic-ai/sdk');
const { DateTime } = require('luxon');
const config = require('./config');
const sheetWrite = require('./sheetWrite');
const groups = require('./groups');
const rotations = require('./rotations');
const { parseDays, parseTime } = require('./schedule');
const { sendEntry } = require('./sender');
const { renderEntry } = require('./template');

let client = null;
function getClient() {
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return client;
}

const tools = [
  {
    name: 'list_schedule',
    description:
      'List every scheduled message: row number, group name, message text, days, time, timezone, active. Call this FIRST to find the right row before editing, deleting, or sending.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_whatsapp_groups',
    description:
      'List the WhatsApp groups the bot is a member of (name + id). Use this to find the right group when ADDING a new scheduled message.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_rotations',
    description:
      "List weekly rotations (e.g. attendance duty) and who is assigned THIS week. Use to answer questions like \"whose turn is it?\" A message can reference a rotation with the placeholder {rotation:NAME}.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'update_message',
    description: 'Replace the entire message text of one row (by row number).',
    input_schema: {
      type: 'object',
      properties: {
        row: { type: 'integer' },
        message: { type: 'string' },
      },
      required: ['row', 'message'],
    },
  },
  {
    name: 'replace_text',
    description:
      'Find and replace text inside message(s) — e.g. "swap Jacob for John". Optionally scope to a group by name.',
    input_schema: {
      type: 'object',
      properties: {
        find: { type: 'string' },
        replace: { type: 'string' },
        group_name: { type: 'string', description: 'Optional: only groups whose name contains this' },
      },
      required: ['find', 'replace'],
    },
  },
  {
    name: 'set_active',
    description: 'Pause (active=false) or resume (active=true) a scheduled message by row number.',
    input_schema: {
      type: 'object',
      properties: { row: { type: 'integer' }, active: { type: 'boolean' } },
      required: ['row', 'active'],
    },
  },
  {
    name: 'add_message',
    description:
      'Add a NEW recurring scheduled message to a group. Resolve the group by name (use list_whatsapp_groups if unsure). Days is "Daily"/"Weekdays"/"Weekends" or a list like "Mon,Wed,Fri". Time is 24h "HH:MM" or "9:00 AM".',
    input_schema: {
      type: 'object',
      properties: {
        group_name: { type: 'string', description: 'Name of an existing WhatsApp group' },
        message: { type: 'string' },
        days: { type: 'string' },
        time: { type: 'string' },
        timezone: { type: 'string', description: 'Optional IANA tz; defaults to the bot default' },
      },
      required: ['group_name', 'message', 'days', 'time'],
    },
  },
  {
    name: 'delete_message',
    description: 'Permanently remove a scheduled message by row number. Confirm with the user before calling.',
    input_schema: {
      type: 'object',
      properties: { row: { type: 'integer' } },
      required: ['row'],
    },
  },
  {
    name: 'send_now',
    description:
      "Send a scheduled message's content to its group IMMEDIATELY (in addition to its normal schedule). Confirm with the user before calling.",
    input_schema: {
      type: 'object',
      properties: { row: { type: 'integer' } },
      required: ['row'],
    },
  },
];

const MUTATING = new Set(['update_message', 'replace_text', 'set_active', 'add_message', 'delete_message']);

async function executeTool(name, input, ctx) {
  switch (name) {
    case 'list_schedule':
      return await sheetWrite.readRows(config);

    case 'list_whatsapp_groups': {
      const g = groups.all();
      return g.length ? g.map((x) => ({ name: x.name, size: x.size })) : { note: 'No groups cached yet — the bot may still be connecting to WhatsApp.' };
    }

    case 'list_rotations': {
      const now = DateTime.now();
      const rl = rotations.list();
      return rl.length
        ? rl.map((r) => ({ name: r.name, members: r.members, thisWeek: rotations.currentMember(r.name, now) }))
        : { note: 'No rotations are configured.' };
    }

    case 'update_message':
      return await sheetWrite.updateMessage(config, input.row, input.message);

    case 'set_active':
      return await sheetWrite.setActive(config, input.row, input.active);

    case 'replace_text': {
      const changed = await sheetWrite.replaceText(config, input.find, input.replace, input.group_name);
      return changed.length ? changed : { note: 'No messages contained that text; nothing changed.' };
    }

    case 'add_message': {
      const { days, error: dErr } = parseDays(input.days);
      if (dErr) return { error: `Days problem: ${dErr}. Use "Daily", "Weekdays", or a list like "Mon,Wed,Fri".` };
      const { error: tErr } = parseTime(input.time);
      if (tErr) return { error: `Time problem: ${tErr}. Use "HH:MM" (e.g. 09:00) or "9:00 AM".` };

      const r = groups.resolve(input.group_name);
      if (r.none) return { error: `No WhatsApp group matches "${input.group_name}". Call list_whatsapp_groups to see valid names.` };
      if (r.matches) return { error: `"${input.group_name}" matches several groups: ${r.matches.map((m) => m.name).join(', ')}. Ask the user which one.` };

      await sheetWrite.appendRow(config, {
        groupName: r.match.name,
        jid: r.match.jid,
        message: input.message,
        days: input.days,
        time: input.time,
        timezone: input.timezone || config.defaultTimezone,
      });
      return { added: { group: r.match.name, message: input.message, days: input.days, time: input.time } };
    }

    case 'delete_message':
      return await sheetWrite.clearRow(config, input.row);

    case 'send_now': {
      const sock = ctx.getSock && ctx.getSock();
      if (!sock) return { error: 'Not connected to WhatsApp right now — try again in a moment.' };
      const rows = await sheetWrite.readRows(config);
      const entry = rows.find((x) => x.row === input.row);
      if (!entry) return { error: `No scheduled message at row ${input.row}.` };
      if (!entry.jid) return { error: `Row ${input.row} has no group id.` };
      const toSend = renderEntry(
        { jid: entry.jid, message: entry.message, mediaUrl: entry.mediaUrl, groupName: entry.groupName, timezone: entry.timezone },
        DateTime.now()
      );
      const result = await sendEntry(sock, toSend, config);
      return result.ok
        ? { sent: { group: entry.groupName, dryRun: !!result.dryRun } }
        : { error: `Send failed: ${result.error}` };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function systemPrompt() {
  const now = DateTime.now().setZone(config.defaultTimezone);
  return [
    "You control a WhatsApp scheduled-message bot by managing its Google Sheet on the user's behalf.",
    'Each row is one recurring scheduled message: group name, message text, days, time, timezone, active flag.',
    '',
    `Today is ${now.toFormat('cccc, LLLL d, yyyy')} (${config.defaultTimezone}). Use this for relative references like "this week".`,
    '',
    'What you can do: list the schedule, list the WhatsApp groups, list rotations, edit message text,',
    'swap words (replace_text), pause/resume, ADD a new scheduled message, DELETE one, or SEND one immediately.',
    '',
    'Messages may contain dynamic placeholders resolved when sent: {rotation:NAME} (this week\'s assigned',
    'person of a weekly rotation), {next_saturday} (upcoming Saturday date), {today}. Use list_rotations to',
    'answer "whose turn is it?" and when adding rotation-based reminders.',
    '',
    'Rules:',
    '- Call list_schedule first to find the right row before editing/deleting/sending. Never invent row numbers.',
    '- To add a message, resolve the group with list_whatsapp_groups; if the name is ambiguous, ask which group.',
    '- CONFIRM with the user before delete_message or send_now (these are destructive or send to the group now). If they already said yes, proceed.',
    '- Apply plain edits (update/replace/pause/resume/add) directly, then reply with a short confirmation of exactly what changed.',
    '- If a request is ambiguous or a target is not found, ask a short clarifying question instead of guessing.',
    '- Keep replies concise — this is a text chat.',
  ].join('\n');
}

/**
 * Handle one user message within an optional prior conversation.
 * @param {string} userText
 * @param {{ history?: Array, getSock?: () => object|null }} ctx
 * @returns {Promise<{reply: string, changed: boolean}>}
 */
async function handleMessage(userText, ctx = {}) {
  const history = ctx.history || [];
  const messages = [...history, { role: 'user', content: userText }];
  let changed = false;

  for (let step = 0; step < 8; step++) {
    const resp = await getClient().messages.create({
      model: config.anthropicModel,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system: systemPrompt(),
      tools,
      messages,
    });

    if (resp.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: resp.content });
      const results = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        try {
          const out = await executeTool(block.name, block.input, ctx);
          // A `.note` result means the tool ran but changed nothing (e.g.
          // replace_text matched zero messages) — don't trigger a refresh.
          if (MUTATING.has(block.name) && !out?.error && !out?.note) changed = true;
          results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${err.message}`, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });
      continue;
    }

    const text = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return { reply: text || '(done)', changed };
  }

  return { reply: 'That needed too many steps — please try rephrasing.', changed };
}

module.exports = { handleMessage };
