// Telegram control bot. You text it in plain English; it manages your schedule
// via the Claude agent. Only whitelisted Telegram user IDs are allowed.

const { Bot } = require('grammy');
const { handleMessage } = require('./agent');

const MAX_HISTORY = 12; // keep the last few turns per chat for context

/**
 * Start the Telegram bot (long polling). Non-blocking.
 * @param {object} config
 * @param {{ onChanged?: () => void, getSock?: () => object|null }} hooks
 * @returns {Bot}
 */
function startTelegramBot(config, { onChanged, getSock } = {}) {
  const bot = new Bot(config.telegramToken);
  const allowed = config.telegramAllowedUserIds;
  const histories = new Map(); // chatId -> [{role, content}]

  if (allowed.length === 0) {
    console.warn(
      '⚠ TELEGRAM_ALLOWED_USER_IDS is empty — the bot will refuse everyone until you set it.\n' +
        '  Message the bot once; it will reply with your Telegram ID to add.'
    );
  }

  // Auth gate: only whitelisted users may control the bot.
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id || !allowed.includes(id)) {
      await ctx.reply(
        `⛔ Not authorized. Your Telegram ID is ${id}.\n` +
          `Add it to TELEGRAM_ALLOWED_USER_IDS in .env and restart to enable control.`
      );
      return;
    }
    await next();
  });

  bot.command('start', (ctx) => {
    histories.delete(ctx.chat.id);
    return ctx.reply(
      [
        '👋 I manage your WhatsApp scheduled messages. Just text me, e.g.:',
        '• what’s scheduled today?',
        '• swap Jacob for John in the cleanup message',
        '• add a message to the Family group: "Good morning ☀️" every day at 9am',
        '• pause the Work group',
        '• send the cleanup message now',
        '',
        'Tip: /reset clears our conversation context.',
      ].join('\n')
    );
  });
  bot.command('help', (ctx) => ctx.reply('Text me in plain English. /reset clears context.'));
  bot.command('reset', (ctx) => {
    histories.delete(ctx.chat.id);
    return ctx.reply('🧹 Context cleared.');
  });

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    try {
      await ctx.replyWithChatAction('typing');
      const history = histories.get(chatId) || [];
      const { reply, changed } = await handleMessage(ctx.message.text, { history, getSock });

      // Persist a text-only view of this turn for conversational context.
      const next = [...history, { role: 'user', content: ctx.message.text }, { role: 'assistant', content: reply }];
      histories.set(chatId, next.slice(-MAX_HISTORY));

      if (changed && onChanged) onChanged();
      await ctx.reply(reply);
    } catch (err) {
      console.error('Telegram handler error:', err.message);
      await ctx.reply(`⚠ Something went wrong: ${err.message}`);
    }
  });

  bot.catch((err) => console.error('Telegram bot error:', err.message));

  // bot.start() runs the long-polling loop forever, so we can't await it. But
  // bot.catch only covers errors while *handling* updates — startup failures
  // (e.g. a bad TELEGRAM_BOT_TOKEN) surface as a rejection here. Without this
  // .catch() that rejection is unhandled and would crash the ENTIRE process,
  // taking WhatsApp scheduling down with it. Instead we log and degrade: the
  // rest of the bot keeps running without Telegram control.
  bot
    .start({
      onStart: (info) =>
        console.log(`✓ Telegram control bot started (@${info.username}).`),
    })
    .catch((err) => {
      console.error(
        `⚠ Telegram bot failed to start: ${err.message}\n` +
          '  Check TELEGRAM_BOT_TOKEN. WhatsApp scheduling continues without Telegram.'
      );
    });
  return bot;
}

module.exports = { startTelegramBot };
