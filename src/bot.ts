import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { NewApiClient } from './new-api.js';
import { NewApiError } from './new-api.js';
import { sendMessageWithRetry } from './telegram.js';
import { localeFromTelegramLanguage, t, welcomeMessage, type Locale } from './i18n.js';
import {
  formatNotificationPreference,
  formatNotice,
  formatQuota,
  formatRepositoryStats,
  formatSubscriptions,
  formatTimestamp,
  formatUsage,
} from './format.js';
import type {
  BotRepository,
  ApiAccess,
  ApiKey,
  CryptoAsset,
  CryptoNetwork,
  NewApiAccount,
  NewApiStatus,
  NotificationPreference,
  TopUpOptions,
  TopUpOrder,
  TopUpPaymentMethod,
  TopUpStatus,
} from './types.js';

const privateOnly = t('zh', 'privateOnly');

function menu(locale: Locale = 'zh'): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(locale, 'bind'), 'bind').text(t(locale, 'account'), 'account').row()
    .text(t(locale, 'usage'), 'usage').text(t(locale, 'subscription'), 'subscription').row()
    .text(t(locale, 'models'), 'models').text(t(locale, 'apiAccess'), 'api-access').row()
    .text(t(locale, 'topup'), 'topup').row()
    .text(t(locale, 'notice'), 'notice').text(t(locale, 'settings'), 'settings').row()
    .text(t(locale, 'support'), 'support').text(t(locale, 'help'), 'resources').row()
    .text(t(locale, 'language'), 'language').text(t(locale, 'unbind'), 'unbind');
}

function resourceMenu(locale: Locale, config: Config): InlineKeyboard {
  const keyboard = new InlineKeyboard().url(t(locale, 'website'), config.newApiPortalUrl);
  if (config.newApiDocsUrl) keyboard.url(t(locale, 'docs'), config.newApiDocsUrl);
  keyboard.row().url(t(locale, 'modelSquare'), config.newApiPricingUrl)
    .text(t(locale, 'returnToMenu'), 'menu');
  return keyboard;
}

const pendingBroadcasts = new Map<string, string>();
const contextLocales = new WeakMap<Context, Locale>();
type UsageRange = '24h' | 'today' | '7d' | '30d';
const sensitiveSupportContent = /(?:\b(?:authorization|bearer|api[-_ ]?key|password|cvv)\b|sk-[\w-]{8,}|密码|密钥|验证码|(?:\d[ -]?){13,19})/i;

function isPrivate(ctx: Context): boolean {
  return ctx.chat?.type === 'private';
}

function localeFor(ctx: Context): Locale {
  return contextLocales.get(ctx) ?? localeFromTelegramLanguage(ctx.from?.language_code);
}

function telegramUserFromContext(ctx: Context) {
  const user = ctx.from;
  const chat = ctx.chat;
  if (!user || !chat) return null;
  return {
    telegramUserId: String(user.id),
    chatId: String(chat.id),
    ...(user.username ? { username: user.username } : {}),
    ...([user.first_name, user.last_name].filter(Boolean).join(' ')
      ? { displayName: [user.first_name, user.last_name].filter(Boolean).join(' ') }
      : {}),
    locale: localeFromTelegramLanguage(user.language_code),
  };
}

export type BotDependencies = {
  config: Config;
  repository: BotRepository;
  newApi: NewApiClient;
  logger: Logger;
};

export function createBot(deps: BotDependencies): Bot {
  const bot = new Bot(deps.config.telegramBotToken);

  bot.use(async (ctx, next) => {
    if (ctx.update.update_id !== undefined) {
      const accepted = await deps.repository.claimUpdate(ctx.update.update_id);
      if (!accepted) return;
    }
    const user = telegramUserFromContext(ctx);
    if (user) contextLocales.set(ctx, (await deps.repository.upsertTelegramUser(user)).locale);
    await next();
  });

  bot.catch((error) => {
    deps.logger.error({ err: error.error, updateId: error.ctx.update.update_id }, 'telegram update failed');
  });

  bot.command('start', async (ctx) => {
    if (!isPrivate(ctx)) return void (await ctx.reply(t(localeFor(ctx), 'privateOnly')));
    const locale = localeFor(ctx);
    const identity = telegramUserFromContext(ctx);
    const binding = identity ? await deps.repository.getBinding(identity.telegramUserId) : null;
    const linked = binding
      ? locale === 'en'
        ? `\n\nLinked account: ${binding.usernameSnapshot}`
        : `\n\n已绑定账号：${binding.usernameSnapshot}`
      : locale === 'en'
        ? '\n\nNo account linked yet. Select Link account after binding Telegram in SuperToken.'
        : '\n\n尚未绑定账号。请先在 SuperToken 网页绑定 Telegram，再选择“绑定账号”。';
    await ctx.reply(`${welcomeMessage(locale, identity?.displayName)}${linked}`, { reply_markup: menu(locale) });
    await ctx.reply(t(locale, 'helpHint'), { reply_markup: resourceMenu(locale, deps.config) });
  });

  bot.command('help', async (ctx) => {
    const locale = localeFor(ctx);
    const bindHelp = deps.config.newApiIntegrationMode === 'bridge'
      ? locale === 'en' ? '/bind link an account (Bridge mode)' : '/bind 绑定账号（Bridge 模式）'
      : locale === 'en' ? '/bind <user ID> link an account (official mode)' : '/bind <用户ID> 绑定账号（官方模式）';
    const help = locale === 'en'
      ? `Available commands:\n${bindHelp}\n/account View account\n/usage [today|7d|30d] View usage\n/subscription View subscription\n/topup Open top-up portal\n/notice View announcements\n/settings Manage notifications\n/notify <quota|off|pause|resume> Change notifications\n/support <question> Contact support (never send keys, passwords, or payment credentials)\n/unbind Remove the Bot-side link`
      : `可用功能：\n${bindHelp}\n/account 查看账户\n/usage [today|7d|30d] 查看用量\n/subscription 查看订阅\n/topup 打开充值入口\n/notice 查看公告\n/settings 查看通知设置\n/notify <额度|off|pause|resume> 修改通知\n/support <问题> 联系客服（不要提供密钥、密码或支付凭证）\n/unbind 解除机器人绑定`;
    await ctx.reply(help, { reply_markup: menu(locale) });
  });

  bot.command('bind', async (ctx) => {
    await handleBind(ctx, deps);
  });
  bot.command('account', async (ctx) => {
    await handleAccount(ctx, deps);
  });
  bot.command('usage', async (ctx) => {
    await handleUsage(ctx, deps, normalizeUsageRange(ctx.match?.toString().trim()));
  });
  bot.command('subscription', async (ctx) => {
    await handleSubscription(ctx, deps);
  });
  bot.command('topup', async (ctx) => {
    const argument = ctx.match?.toString().trim();
    const amount = parseTopUpAmount(argument);
    if (argument && amount === undefined) {
      const locale = localeFor(ctx);
      await ctx.reply(locale === 'en' ? 'The top-up amount must be a positive integer, for example: /topup 10.' : '充值金额必须是正整数，例如：/topup 10。', { reply_markup: menu(locale) });
      return;
    }
    await handleTopUp(ctx, deps, amount);
  });
  bot.command('keys', async (ctx) => {
    await handleApiKeys(ctx, deps);
  });
  bot.command('language', async (ctx) => {
    await showLanguageSelector(ctx, localeFor(ctx));
  });
  bot.command('unbind', async (ctx) => {
    await handleUnbind(ctx, deps);
  });
  bot.command('notice', async (ctx) => {
    await handleNotice(ctx, deps);
  });
  bot.command('settings', async (ctx) => {
    await handleSettings(ctx, deps);
  });
  bot.command('notify', async (ctx) => {
    await handleNotify(ctx, deps);
  });
  bot.command('support', async (ctx) => {
    await handleSupport(ctx, deps);
  });
  bot.command('id', async (ctx) => {
    if (!isPrivate(ctx) || !ctx.from) return void (await ctx.reply(t(localeFor(ctx), 'privateOnly')));
    await ctx.reply(localeFor(ctx) === 'en' ? `Your Telegram ID: ${ctx.from.id}` : `你的 Telegram ID：${ctx.from.id}`);
  });
  bot.command('admin', async (ctx) => {
    await handleAdmin(ctx, deps);
  });
  bot.command('broadcast', async (ctx) => {
    await handleBroadcast(ctx, deps);
  });
  bot.command('close', async (ctx) => {
    await handleCloseTicket(ctx, deps);
  });

  bot.callbackQuery('bind', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!isPrivate(ctx)) return ctx.reply(t(localeFor(ctx), 'privateOnly'));
    if (deps.config.newApiIntegrationMode === 'bridge') {
      try {
        const account = await deps.newApi.resolveAccountByTelegramId(String(ctx.from.id));
        await saveBinding(ctx, deps, account);
        return ctx.reply('账号绑定成功。', { reply_markup: menu() });
      } catch (error) {
        return ctx.reply(bindFailureMessage(error, true));
      }
    }
    return ctx.reply('请先在 new-api 网页完成 Telegram 绑定，然后发送：/bind 用户ID');
  });
  bot.callbackQuery('account', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleAccount(ctx, deps);
  });
  bot.callbackQuery('usage', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleUsage(ctx, deps, '24h');
  });
  bot.callbackQuery(/^usage:(today|7d|30d)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleUsage(ctx, deps, normalizeUsageRange(ctx.match?.[1]));
  });
  bot.callbackQuery('subscription', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleSubscription(ctx, deps);
  });
  bot.callbackQuery('models', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleAvailableModels(ctx, deps);
  });
  bot.callbackQuery('api-access', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleApiAccess(ctx, deps);
  });
  bot.callbackQuery('keys', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleApiKeys(ctx, deps);
  });
  bot.callbackQuery('keys:create', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showApiKeyProfiles(ctx, deps);
  });
  bot.callbackQuery(/^keys:create:(\d{1,3})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await confirmApiKeyCreate(ctx, deps, Number(ctx.match?.[1]));
  });
  bot.callbackQuery(/^keys:confirm:(\d{1,3}):([A-Za-z0-9_-]{16,64})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await createApiKey(ctx, deps, Number(ctx.match?.[1]), ctx.match?.[2] ?? '');
  });
  bot.callbackQuery(/^keys:status:(\d{1,10}):(0|1)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await setApiKeyStatus(ctx, deps, Number(ctx.match?.[1]), ctx.match?.[2] === '1');
  });
  bot.callbackQuery(/^keys:delete:(\d{1,10})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await confirmApiKeyDelete(ctx, deps, Number(ctx.match?.[1]));
  });
  bot.callbackQuery(/^keys:deleteconfirm:(\d{1,10})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await deleteApiKey(ctx, deps, Number(ctx.match?.[1]));
  });
  bot.callbackQuery(/^models:(\d{1,5})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleAvailableModels(ctx, deps, ctx.match?.[1]);
  });
  bot.callbackQuery('topup', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleTopUp(ctx, deps);
  });
  bot.callbackQuery('topup:custom', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('请输入自定义充值金额，例如：/topup 300。', { reply_markup: menu(localeFor(ctx)) });
  });
  bot.callbackQuery('language', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showLanguageSelector(ctx, localeFor(ctx));
  });
  bot.callbackQuery(/^language:(zh|en)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const locale = ctx.match?.[1] as Locale | undefined;
    if (!ctx.from || !locale) return;
    await deps.repository.setTelegramUserLocale(String(ctx.from.id), locale);
    contextLocales.set(ctx, locale);
    await ctx.reply(t(locale, 'languageSaved'), { reply_markup: menu(locale) });
  });
  bot.callbackQuery(/^topup:amount:(\d{1,15})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleTopUp(ctx, deps, parseTopUpAmount(ctx.match?.[1]));
  });
  bot.callbackQuery(/^topup:quote:(\d{1,15}):(alipay|wxpay)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const amount = parseTopUpAmount(ctx.match?.[1]);
    const paymentMethod = ctx.match?.[2] as TopUpPaymentMethod['type'] | undefined;
    if (!amount || !paymentMethod) return void (await ctx.reply('充值请求无效，请重新选择金额。', { reply_markup: menu() }));
    await handleTopUpQuote(ctx, deps, amount, paymentMethod);
  });
  bot.callbackQuery(/^topup:crypto:(\d{1,15})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const amount = parseTopUpAmount(ctx.match?.[1]);
    if (!amount) return void (await ctx.reply('充值请求无效，请重新选择金额。', { reply_markup: menu() }));
    await showCryptoAssets(ctx, await getTopUpOptions(ctx, deps), amount);
  });
  bot.callbackQuery(/^topup:crypto:asset:(\d{1,15}):(USDT|USDC)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const amount = parseTopUpAmount(ctx.match?.[1]);
    const asset = ctx.match?.[2] as CryptoAsset | undefined;
    if (!amount || !asset) return void (await ctx.reply('充值请求无效，请重新选择金额。', { reply_markup: menu() }));
    await showCryptoNetworks(ctx, await getTopUpOptions(ctx, deps), amount, asset);
  });
  bot.callbackQuery(/^topup:crypto:network:(\d{1,15}):(USDT|USDC):(bsc|ethereum|base|solana)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const amount = parseTopUpAmount(ctx.match?.[1]);
    const asset = ctx.match?.[2] as CryptoAsset | undefined;
    const network = ctx.match?.[3] as CryptoNetwork | undefined;
    if (!amount || !asset || !network) return void (await ctx.reply('充值请求无效，请重新选择金额。', { reply_markup: menu() }));
    await handleTopUpQuote(ctx, deps, amount, 'crypto', { asset, network });
  });
  bot.callbackQuery(/^topup:create:(\d{1,15}):(alipay|wxpay)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const amount = parseTopUpAmount(ctx.match?.[1]);
    const paymentMethod = ctx.match?.[2] as TopUpPaymentMethod['type'] | undefined;
    if (!amount || !paymentMethod) return void (await ctx.reply('充值请求无效，请重新选择金额。', { reply_markup: menu() }));
    await handleTopUpOrderCreate(ctx, deps, amount, paymentMethod);
  });
  bot.callbackQuery(/^topup:crypto:create:(\d{1,15}):(USDT|USDC):(bsc|ethereum|base|solana)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const amount = parseTopUpAmount(ctx.match?.[1]);
    const asset = ctx.match?.[2] as CryptoAsset | undefined;
    const network = ctx.match?.[3] as CryptoNetwork | undefined;
    if (!amount || !asset || !network) return void (await ctx.reply('充值请求无效，请重新选择金额。', { reply_markup: menu() }));
    await handleTopUpOrderCreate(ctx, deps, amount, 'crypto', { asset, network });
  });
  bot.callbackQuery(/^topup:status:([A-Za-z0-9]{1,48})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleTopUpStatus(ctx, deps, ctx.match?.[1] ?? '');
  });
  bot.callbackQuery('topup:cancel', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('已取消本次充值操作。', { reply_markup: menu() });
  });
  bot.callbackQuery('resources', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(t(localeFor(ctx), 'helpHint'), { reply_markup: resourceMenu(localeFor(ctx), deps.config) });
  });
  const showPrimaryMenu = async (ctx: Context) => {
    await ctx.answerCallbackQuery();
    const locale = localeFor(ctx);
    await ctx.reply(t(locale, 'helpHint'), { reply_markup: menu(locale) });
  };
  bot.callbackQuery('menu', showPrimaryMenu);
  // Old Telegram messages used `help` for a button labelled "返回菜单".
  bot.callbackQuery('help', showPrimaryMenu);
  bot.callbackQuery('unbind', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleUnbind(ctx, deps);
  });
  bot.callbackQuery('notice', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleNotice(ctx, deps);
  });
  bot.callbackQuery('settings', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleSettings(ctx, deps);
  });
  bot.callbackQuery('support', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleSupport(ctx, deps);
  });
  bot.callbackQuery('settings:pause', async (ctx) => {
    await ctx.answerCallbackQuery();
    await toggleNotificationPause(ctx, deps);
  });
  bot.callbackQuery('settings:clear', async (ctx) => {
    await ctx.answerCallbackQuery();
    await clearNotificationThreshold(ctx, deps);
  });
  bot.callbackQuery('broadcast:confirm', async (ctx) => {
    await ctx.answerCallbackQuery();
    await confirmBroadcast(ctx, deps);
  });
  bot.callbackQuery('broadcast:cancel', async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.from) pendingBroadcasts.delete(String(ctx.from.id));
    await ctx.reply('已取消广播。');
  });

  bot.on('message:text', async (ctx) => {
    await handleSupportReply(ctx, deps);
  });

  return bot;
}

async function showLanguageSelector(ctx: Context, locale: Locale): Promise<void> {
  await ctx.reply(t(locale, 'languageTitle'), {
    reply_markup: new InlineKeyboard()
      .text(locale === 'zh' ? '中文 ✓' : '中文', 'language:zh')
      .text(locale === 'en' ? 'English ✓' : 'English', 'language:en')
      .row()
      .text(t(locale, 'returnToMenu'), 'menu'),
  });
}

function isAdmin(ctx: Context, deps: BotDependencies): boolean {
  return Boolean(ctx.from && deps.config.botAdminTelegramIds.has(String(ctx.from.id)));
}

function normalizeUsageRange(value: string | undefined): UsageRange {
  if (value === 'today' || value === '7d' || value === '30d') return value;
  return '24h';
}

function usageWindow(range: UsageRange, end: number, locale: Locale): { start: number; title: string } {
  if (range === 'today') {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(end * 1000));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const start = Math.floor((Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)) - 8 * 3600000) / 1000);
    return { start, title: locale === 'en' ? 'Usage today' : '今日用量' };
  }
  if (range === '7d') return { start: end - 7 * 24 * 60 * 60, title: locale === 'en' ? 'Usage in the last 7 days' : '近 7 天用量' };
  if (range === '30d') return { start: end - 30 * 24 * 60 * 60, title: locale === 'en' ? 'Usage in the last 30 days' : '近 30 天用量' };
  return { start: end - 24 * 60 * 60, title: locale === 'en' ? 'Usage in the last 24 hours' : '近 24 小时用量' };
}

async function handleNotice(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  const locale = localeFor(ctx);
  try {
    await ctx.reply(formatNotice(await deps.newApi.getNotice(), locale), { reply_markup: menu(locale) });
  } catch (error) {
    await ctx.reply(userFacingError(error, locale), { reply_markup: menu(locale) });
  }
}

async function handleSettings(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  const identity = telegramUserFromContext(ctx);
  if (!identity) return;
  const locale = localeFor(ctx);
  try {
    const preference = await deps.repository.getNotificationPreference(identity.telegramUserId);
    const keyboard = new InlineKeyboard()
      .text(preference.paused ? (locale === 'en' ? 'Resume notifications' : '恢复通知') : (locale === 'en' ? 'Pause notifications' : '暂停通知'), 'settings:pause')
      .text(locale === 'en' ? 'Clear low-balance alert' : '关闭低余额提醒', 'settings:clear').row()
      .text(locale === 'en' ? 'Help: /notify 100000' : '帮助：/notify 100000', 'help');
    await ctx.reply(`${formatNotificationPreference(preference, locale)}\n\n${locale === 'en' ? 'Use /notify <quota> to set a low-balance threshold.' : '使用 /notify <额度> 设置低余额阈值。'}`, {
      reply_markup: keyboard,
    });
  } catch (error) {
    await ctx.reply(userFacingError(error, locale), { reply_markup: menu(locale) });
  }
}

async function handleNotify(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  const identity = telegramUserFromContext(ctx);
  if (!identity) return;
  const locale = localeFor(ctx);
  const argument = ctx.match?.toString().trim().toLowerCase() ?? '';
  const preference = await deps.repository.getNotificationPreference(identity.telegramUserId);
  if (!argument) {
    await handleSettings(ctx, deps);
    return;
  }
  if (argument === 'pause' || argument === 'resume') {
    const updated = { ...preference, paused: argument === 'pause', updatedAt: new Date() };
    await deps.repository.saveNotificationPreference(updated);
    await deps.repository.writeAudit({ actorTelegramUserId: identity.telegramUserId, action: `notification.${argument}` });
    await ctx.reply(formatNotificationPreference(updated, locale), { reply_markup: menu(locale) });
    return;
  }
  if (argument === 'off') {
    const updated: NotificationPreference = { ...preference, lowQuotaThreshold: undefined, updatedAt: new Date() };
    await deps.repository.saveNotificationPreference(updated);
    await deps.repository.writeAudit({ actorTelegramUserId: identity.telegramUserId, action: 'notification.threshold_cleared' });
    await ctx.reply(formatNotificationPreference(updated, locale), { reply_markup: menu(locale) });
    return;
  }
  const threshold = Number(argument);
  if (!Number.isSafeInteger(threshold) || threshold < 0) {
    await ctx.reply(locale === 'en' ? 'Usage: /notify 100000, /notify off, /notify pause, or /notify resume' : '格式：/notify 100000、/notify off、/notify pause 或 /notify resume');
    return;
  }
  const updated: NotificationPreference = { ...preference, lowQuotaThreshold: threshold, updatedAt: new Date() };
  await deps.repository.saveNotificationPreference(updated);
  await deps.repository.writeAudit({
    actorTelegramUserId: identity.telegramUserId,
    action: 'notification.threshold_set',
    metadata: { threshold },
  });
  await ctx.reply(formatNotificationPreference(updated, locale), { reply_markup: menu(locale) });
}

async function toggleNotificationPause(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  const identity = telegramUserFromContext(ctx);
  if (!identity) return;
  const locale = localeFor(ctx);
  const preference = await deps.repository.getNotificationPreference(identity.telegramUserId);
  const updated = { ...preference, paused: !preference.paused, updatedAt: new Date() };
  await deps.repository.saveNotificationPreference(updated);
  await ctx.reply(formatNotificationPreference(updated, locale), { reply_markup: menu(locale) });
}

async function clearNotificationThreshold(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  const identity = telegramUserFromContext(ctx);
  if (!identity) return;
  const locale = localeFor(ctx);
  const preference = await deps.repository.getNotificationPreference(identity.telegramUserId);
  const updated: NotificationPreference = { ...preference, lowQuotaThreshold: undefined, updatedAt: new Date() };
  await deps.repository.saveNotificationPreference(updated);
  await ctx.reply(formatNotificationPreference(updated, locale), { reply_markup: menu(locale) });
}

async function handleSupport(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  const locale = localeFor(ctx);
  if (!deps.config.supportChatId) {
    await ctx.reply(locale === 'en' ? 'Support is not configured yet. Please try again later.' : '客服入口尚未配置，请稍后重试。', { reply_markup: menu(locale) });
    return;
  }
  const identity = telegramUserFromContext(ctx);
  if (!identity) return;
  const message = ctx.match?.toString().trim() ?? '';
  if (!message) {
    await ctx.reply(locale === 'en' ? 'Use /support followed by your question, for example: /support I cannot sign in. Do not send keys, passwords, or payment credentials.' : '请使用 /support 加上你的问题，例如：/support 无法登录。请勿提供密钥、密码或支付凭证。', { reply_markup: menu(locale) });
    return;
  }
  const safeMessage = message.length > 3500 ? `${message.slice(0, 3497)}...` : message;
  if (sensitiveSupportContent.test(safeMessage)) {
    await ctx.reply(locale === 'en' ? 'Do not send keys, passwords, verification codes, or payment credentials through the Bot. Remove sensitive data and describe the problem only.' : '请勿通过机器人发送密钥、密码、验证码或支付凭证。请删除敏感信息后仅描述问题。', { reply_markup: menu(locale) });
    return;
  }
  try {
    const forwarded = await sendMessageWithRetry(
      ctx.api,
      deps.config.supportChatId,
      `新客服工单\n用户 ID：${identity.telegramUserId}\n用户名：${identity.username ?? '-'}\n\n${safeMessage}`,
    );
    const ticket = await deps.repository.createSupportTicket({
      telegramUserId: identity.telegramUserId,
      chatId: identity.chatId,
      opsChatId: deps.config.supportChatId,
      opsMessageId: forwarded.message_id,
    });
    await ctx.api.editMessageText(
      deps.config.supportChatId,
      forwarded.message_id,
      `工单 ${ticket.ticketNo}\n用户 ID：${identity.telegramUserId}\n用户名：${identity.username ?? '-'}\n\n${safeMessage}`,
    );
    await deps.repository.writeAudit({
      actorTelegramUserId: identity.telegramUserId,
      action: 'support.created',
      targetType: 'support_ticket',
      targetId: ticket.ticketNo,
    });
    await ctx.reply(locale === 'en' ? `Ticket submitted: ${ticket.ticketNo}\nSupport will reply in this chat.` : `工单已提交：${ticket.ticketNo}\n客服会在此对话回复你。`, { reply_markup: menu(locale) });
  } catch (error) {
    deps.logger.warn({ err: error }, 'support ticket creation failed');
    await ctx.reply(locale === 'en' ? 'The support ticket could not be submitted. Please try again later.' : '工单暂时提交失败，请稍后重试。', { reply_markup: menu(locale) });
  }
}

async function handleSupportReply(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!deps.config.supportChatId || !ctx.chat || String(ctx.chat.id) !== deps.config.supportChatId) return;
  const message = ctx.message;
  const text = message?.text;
  if (!message || !text || text.startsWith('/')) return;
  const replyTo = message.reply_to_message?.message_id;
  if (!replyTo) return;
  const ticket = await deps.repository.findSupportTicketByOpsMessage(deps.config.supportChatId, replyTo);
  if (!ticket) return;
  if (ticket.status === 'closed') {
    await ctx.reply('该工单已关闭，不能继续回复。');
    return;
  }
  await sendMessageWithRetry(ctx.api, ticket.chatId, `客服回复（${ticket.ticketNo}）\n\n${text}`);
  await deps.repository.writeAudit({ action: 'support.replied', targetType: 'support_ticket', targetId: ticket.ticketNo });
}

async function handleCloseTicket(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!deps.config.supportChatId || !ctx.chat || String(ctx.chat.id) !== deps.config.supportChatId) return;
  const ticketNo = ctx.match?.toString().trim() ?? '';
  if (!ticketNo) return void (await ctx.reply('格式：/close ST-XXXXXX'));
  await deps.repository.closeSupportTicket(ticketNo);
  await deps.repository.writeAudit({ action: 'support.closed', targetType: 'support_ticket', targetId: ticketNo });
  await ctx.reply(`工单 ${ticketNo} 已关闭。`);
}

async function handleAdmin(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  if (!isAdmin(ctx, deps)) return void (await ctx.reply('无权执行此操作。'));
  const locale = localeFor(ctx);
  try {
    await ctx.reply(formatRepositoryStats(await deps.repository.getStats(), locale));
  } catch (error) {
    await ctx.reply(userFacingError(error, locale));
  }
}

async function handleBroadcast(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  if (!isAdmin(ctx, deps)) return void (await ctx.reply('无权执行此操作。'));
  const message = ctx.match?.toString().trim() ?? '';
  if (!message) return void (await ctx.reply('格式：/broadcast 公告内容'));
  const safeMessage = message.length > 3500 ? `${message.slice(0, 3497)}...` : message;
  const targets = await deps.repository.listActiveBindings();
  const adminId = String(ctx.from?.id);
  pendingBroadcasts.set(adminId, safeMessage);
  await ctx.reply(`广播预览\n目标人数：${targets.length}\n\n${safeMessage}\n\n确认发送？`, {
    reply_markup: new InlineKeyboard().text('确认发送', 'broadcast:confirm').text('取消', 'broadcast:cancel'),
  });
}

async function confirmBroadcast(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  if (!isAdmin(ctx, deps)) return void (await ctx.reply('无权执行此操作。'));
  const adminId = String(ctx.from?.id);
  const message = pendingBroadcasts.get(adminId);
  if (!message) return void (await ctx.reply('广播已过期，请重新使用 /broadcast。'));
  pendingBroadcasts.delete(adminId);
  const targets = await deps.repository.listActiveBindings();
  let delivered = 0;
  let failed = 0;
  for (const target of targets) {
    try {
      await sendMessageWithRetry(ctx.api, target.user.chatId, message);
      delivered += 1;
    } catch (error) {
      failed += 1;
      deps.logger.warn({ err: error, telegramUserId: target.user.telegramUserId }, 'broadcast delivery failed');
    }
    if (deps.config.broadcastDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, deps.config.broadcastDelayMs));
  }
  await deps.repository.writeAudit({
    actorTelegramUserId: adminId,
    action: 'broadcast.sent',
    metadata: { targetCount: targets.length, delivered, failed },
  });
  await ctx.reply(`广播完成\n成功：${delivered}\n失败：${failed}`);
}

async function handleBind(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) {
    await ctx.reply(privateOnly);
    return;
  }
  const identity = telegramUserFromContext(ctx);
  if (!identity) return;
  const locale = localeFor(ctx);
  const argument = ctx.match?.toString().trim() ?? '';
  if (deps.config.newApiIntegrationMode === 'bridge' && argument) {
    await ctx.reply(locale === 'en' ? 'Telegram Bridge is enabled. Send /bind without a new-api user ID.' : '当前已启用 Telegram Bridge，请直接发送 /bind，不需要填写 new-api 用户 ID。');
    return;
  }
  if (deps.config.newApiIntegrationMode === 'bridge' && !argument) {
    try {
      const account = await deps.newApi.resolveAccountByTelegramId(identity.telegramUserId);
      await saveBinding(ctx, deps, account);
      await ctx.reply(locale === 'en' ? 'Account linked.' : '账号绑定成功。', { reply_markup: menu(locale) });
    } catch (error) {
      await ctx.reply(bindFailureMessage(error, true, locale));
    }
    return;
  }
  const userId = Number(argument);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    await ctx.reply(locale === 'en' ? 'Enter a valid new-api user ID, for example: /bind 123' : '请输入有效的 new-api 用户 ID，例如：/bind 123');
    return;
  }
  try {
    const account = await deps.newApi.getAccountById(userId);
    if (account.telegramId !== identity.telegramUserId) {
      await deps.repository.writeAudit({
        actorTelegramUserId: identity.telegramUserId,
        action: 'binding.rejected',
        targetType: 'new_api_user',
        targetId: String(userId),
      });
      await ctx.reply(locale === 'en' ? 'Account link failed. Confirm that this Telegram account is linked in your new-api account.' : '绑定失败，请确认你已在 new-api 账号中绑定当前 Telegram。');
      return;
    }
    await saveBinding(ctx, deps, account);
    await ctx.reply(locale === 'en' ? 'Account linked.' : '账号绑定成功。', { reply_markup: menu(locale) });
  } catch (error) {
    await ctx.reply(bindFailureMessage(error, false, locale));
  }
}

async function handleAccount(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  const locale = localeFor(ctx);
  try {
    const account = await resolveBoundAccount(ctx, deps);
    if (!account) return;
    const status = await getStatus(deps);
    await ctx.reply(
      locale === 'en'
        ? `Account: ${account.displayName ?? account.username}\nGroup: ${account.group ?? '-'}\nStatus: ${account.status === 1 ? 'Active' : 'Unavailable'}\nTotal quota: ${formatQuota(account.quota, status)}\nUsed quota: ${formatQuota(account.usedQuota, status)}\nRemaining quota: ${formatQuota(account.quota - account.usedQuota, status)}\nRequests: ${account.requestCount ?? '-'}`
        : `账户：${account.displayName ?? account.username}\n用户组：${account.group ?? '-'}\n状态：${account.status === 1 ? '正常' : '不可用'}\n总额度：${formatQuota(account.quota, status)}\n已用额度：${formatQuota(account.usedQuota, status)}\n剩余额度：${formatQuota(account.quota - account.usedQuota, status)}\n请求数：${account.requestCount ?? '-'}`,
      { reply_markup: menu(locale) },
    );
  } catch (error) {
    await ctx.reply(userFacingError(error, locale), { reply_markup: menu(locale) });
  }
}

async function handleUsage(ctx: Context, deps: BotDependencies, range: UsageRange): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  const locale = localeFor(ctx);
  try {
    const account = await resolveBoundAccount(ctx, deps);
    if (!account) return;
    const status = await getStatus(deps);
    const end = Math.floor(Date.now() / 1000);
    const window = usageWindow(range, end, locale);
    const usage = await deps.newApi.getUsage(account, window.start, end);
    await ctx.reply(`${window.title}\n${formatUsage(usage, status, locale)}`, {
      reply_markup: new InlineKeyboard()
        .text(locale === 'en' ? 'Today' : '今日', 'usage:today').text(locale === 'en' ? '7 days' : '7 天', 'usage:7d').text(locale === 'en' ? '30 days' : '30 天', 'usage:30d').row()
        .text(t(locale, 'returnToMenu'), 'menu'),
    });
  } catch (error) {
    await ctx.reply(userFacingError(error, locale), { reply_markup: menu(locale) });
  }
}

async function handleSubscription(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  const locale = localeFor(ctx);
  try {
    const account = await resolveBoundAccount(ctx, deps);
    if (!account) return;
    const subscriptions = await deps.newApi.getSubscriptions(account);
    await ctx.reply(formatSubscriptions(subscriptions, await getStatus(deps), locale), { reply_markup: menu(locale) });
  } catch (error) {
    await ctx.reply(userFacingError(error, locale), { reply_markup: menu(locale) });
  }
}

async function handleAvailableModels(ctx: Context, deps: BotDependencies, cursor?: string): Promise<void> {
  if (!isPrivate(ctx) || !ctx.from) return void (await ctx.reply(privateOnly));
  try {
    const accountScoped = deps.config.newApiIntegrationMode === 'bridge';
    const page = accountScoped
      ? await deps.newApi.getAvailableModels(String(ctx.from.id), cursor)
      : await deps.newApi.getPublicModels(cursor);
    const locale = localeFor(ctx);
    const rows = page.models.map((model) => {
      const endpointTypes = model.endpointTypes.length > 0 ? ` (${model.endpointTypes.join(', ')})` : '';
      return `- ${model.id}${endpointTypes}`;
    });
    const heading = accountScoped
      ? locale === 'en' ? `Available models (${page.total})` : `当前账户可用模型（${page.total}）`
      : locale === 'en' ? `Public model catalogue (${page.total})` : `公开模型目录（${page.total}）`;
    const empty = locale === 'en' ? 'No models are currently available.' : '当前没有可用模型。';
    const scopeNotice = accountScoped
      ? ''
      : locale === 'en'
        ? '\n\nThis is the public catalogue. Your available models and final prices depend on your account group; check the web portal for the authoritative result.'
        : '\n\n这是站点公开目录。你的实际可用模型和最终价格取决于账号分组，请以网页账户中心为准。';
    const keyboard = new InlineKeyboard();
    if (page.nextCursor) keyboard.text(locale === 'en' ? 'Next page' : '下一页', `models:${page.nextCursor}`).row();
    keyboard.url(t(locale, 'modelSquare'), deps.config.newApiPricingUrl).row().text(t(locale, 'returnToMenu'), 'menu');
    await ctx.reply(`${heading}\n\n${rows.length > 0 ? rows.join('\n') : empty}${scopeNotice}`, { reply_markup: keyboard });
  } catch (error) {
    if (error instanceof NewApiError && error.code === 'api' && error.message === 'telegram account is not bound') {
      await ctx.reply('请先绑定 SuperToken 账号后再查看可用模型。', { reply_markup: menu() });
      return;
    }
    await ctx.reply(localeFor(ctx) === 'en' ? 'The model catalogue is temporarily unavailable.' : '模型目录暂时不可用，请稍后重试。', { reply_markup: menu(localeFor(ctx)) });
  }
}

function apiKeyStatusLabel(locale: Locale, status: ApiKey['status']): string {
  const labels: Record<Locale, Record<ApiKey['status'], string>> = {
    zh: { enabled: '已启用', disabled: '已停用', expired: '已过期', exhausted: '额度耗尽', unknown: '未知' },
    en: { enabled: 'Enabled', disabled: 'Disabled', expired: 'Expired', exhausted: 'Exhausted', unknown: 'Unknown' },
  };
  return labels[locale][status];
}

function formatApiKeyProfile(profile: ApiAccess['profiles'][number]): string {
  return profile.autoGroups?.length ? `${profile.label} (${profile.autoGroups.join(', ')})` : profile.label;
}

function formatApiKey(key: ApiKey, locale: Locale): string {
  const group = key.autoGroups?.length ? `${key.group} (${key.autoGroups.join(', ')})` : key.group || '-';
  const labels = locale === 'en'
    ? { key: 'Key', profile: 'Profile', status: 'Status', expires: 'Expires' }
    : { key: 'Key（已掩码）', profile: '模型分组', status: '状态', expires: '到期时间' };
  return [
    `#${key.id} ${key.name}`,
    `${labels.key}: ${key.maskedKey}`,
    `${labels.profile}: ${group}`,
    `${labels.status}: ${apiKeyStatusLabel(locale, key.status)}`,
    `${labels.expires}: ${formatTimestamp(key.expiresAt)}`,
  ].join('\n');
}

function apiAccessUnavailableMessage(error: unknown, locale: Locale): string {
  if (error instanceof NewApiError && error.code === 'api' && error.message === 'telegram account is not bound') {
    return locale === 'en'
      ? 'Link Telegram to your SuperToken account on the website before using API access.'
      : '请先在 SuperToken 网页绑定当前 Telegram 账号后再使用 API 接入。';
  }
  if (error instanceof NewApiError && error.code === 'config') {
    return locale === 'en' ? 'API access requires the Bridge configuration.' : 'API 接入需要 Bridge 集成配置。';
  }
  return locale === 'en' ? 'API access is temporarily unavailable.' : 'API 接入暂时不可用，请稍后重试。';
}

async function showOfficialApiPortal(ctx: Context, deps: BotDependencies): Promise<void> {
  const locale = localeFor(ctx);
  const text = locale === 'en'
    ? `API access\n\nBase URL:\n${deps.config.newApiBaseUrl}/v1\n\nFor security, standard new-api does not delegate API Key creation, display, enablement, or deletion to a Telegram Bot. Open the authenticated web portal to manage Keys and copy a Key.`
    : `API 接入\n\nBase URL：\n${deps.config.newApiBaseUrl}/v1\n\n为保护账号安全，原生 new-api 不会把 API Key 的创建、展示、启停或删除授权给 Telegram Bot。请在已登录的网页账户中心管理并复制 Key。`;
  const keyboard = new InlineKeyboard().url(locale === 'en' ? 'Open account portal' : '打开账户中心', deps.config.newApiPortalUrl);
  if (deps.config.newApiDocsUrl) keyboard.url(locale === 'en' ? 'API documentation' : 'API 使用文档', deps.config.newApiDocsUrl);
  keyboard.row().text(t(locale, 'returnToMenu'), 'menu');
  await ctx.reply(text, { reply_markup: keyboard });
}

async function handleApiAccess(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx) || !ctx.from) return void (await ctx.reply(privateOnly));
  if (deps.config.newApiIntegrationMode !== 'bridge') return showOfficialApiPortal(ctx, deps);
  const locale = localeFor(ctx);
  try {
    const access = await deps.newApi.getApiAccess(String(ctx.from.id));
    const profiles = access.profiles.map((profile) => `- ${formatApiKeyProfile(profile)}`);
    const heading = locale === 'en' ? 'API access' : 'API 接入';
    const baseUrlLabel = locale === 'en' ? 'Base URL' : 'Base URL';
    const profileLabel = locale === 'en' ? 'Available key profiles' : '可创建 Key 的模型分组';
    const empty = locale === 'en' ? 'No API key profile is currently available.' : '当前没有可用的 Key 模型分组。';
    await ctx.reply(`${heading}\n\n${baseUrlLabel}:\n${access.baseUrl}\n\n${profileLabel}:\n${profiles.length > 0 ? profiles.join('\n') : empty}`, {
      reply_markup: new InlineKeyboard()
        .text(locale === 'en' ? 'Manage API Keys' : '管理 API Key', 'keys')
        .url(locale === 'en' ? 'Keys dashboard' : 'Key 管理页面', access.keyManagementUrl).row()
        .text(t(locale, 'returnToMenu'), 'menu'),
    });
  } catch (error) {
    await ctx.reply(apiAccessUnavailableMessage(error, locale), { reply_markup: menu(locale) });
  }
}

async function handleApiKeys(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx) || !ctx.from) return void (await ctx.reply(privateOnly));
  if (deps.config.newApiIntegrationMode !== 'bridge') return showOfficialApiPortal(ctx, deps);
  const locale = localeFor(ctx);
  try {
    const [access, keys] = await Promise.all([
      deps.newApi.getApiAccess(String(ctx.from.id)),
      deps.newApi.listApiKeys(String(ctx.from.id)),
    ]);
    const lines = keys.length === 0
      ? [locale === 'en' ? 'No API Keys yet.' : '当前没有 API Key。']
      : keys.flatMap((key) => [formatApiKey(key, locale), '']);
    const keyboard = new InlineKeyboard();
    if (keys.length < access.keyLimit && access.profiles.length > 0) {
      keyboard.text(locale === 'en' ? 'Create API Key' : '创建 API Key', 'keys:create').row();
    }
    for (const key of keys) {
      if (key.status === 'enabled' || key.status === 'disabled') {
        keyboard.text(
          key.status === 'enabled'
            ? (locale === 'en' ? `Disable #${key.id}` : `停用 #${key.id}`)
            : (locale === 'en' ? `Enable #${key.id}` : `启用 #${key.id}`),
          `keys:status:${key.id}:${key.status === 'enabled' ? '0' : '1'}`,
        );
      }
      keyboard.text(locale === 'en' ? `Delete #${key.id}` : `删除 #${key.id}`, `keys:delete:${key.id}`).row();
    }
    keyboard.url(locale === 'en' ? 'Keys dashboard' : 'Key 管理页面', access.keyManagementUrl).row()
      .text(t(locale, 'returnToMenu'), 'menu');
    const title = locale === 'en' ? `API Keys (${keys.length}/${access.keyLimit})` : `API Key（${keys.length}/${access.keyLimit}）`;
    await ctx.reply(`${title}\n\n${lines.join('\n')}`, { reply_markup: keyboard });
  } catch (error) {
    await ctx.reply(apiAccessUnavailableMessage(error, locale), { reply_markup: menu(locale) });
  }
}

async function showApiKeyProfiles(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx) || !ctx.from) return void (await ctx.reply(privateOnly));
  if (deps.config.newApiIntegrationMode !== 'bridge') return showOfficialApiPortal(ctx, deps);
  const locale = localeFor(ctx);
  try {
    const access = await deps.newApi.getApiAccess(String(ctx.from.id));
    if (access.profiles.length === 0) {
      await ctx.reply(locale === 'en' ? 'No API key profile is currently available.' : '当前没有可用的 Key 模型分组。', { reply_markup: menu(locale) });
      return;
    }
    const keyboard = new InlineKeyboard();
    access.profiles.forEach((profile, index) => keyboard.text(formatApiKeyProfile(profile), `keys:create:${index}`).row());
    keyboard.text(locale === 'en' ? 'Back to keys' : '返回 Key 列表', 'keys').row().text(t(locale, 'returnToMenu'), 'menu');
    await ctx.reply(locale === 'en' ? 'Choose the model group for this API Key.' : '请选择这个 API Key 可使用的模型分组。', { reply_markup: keyboard });
  } catch (error) {
    await ctx.reply(apiAccessUnavailableMessage(error, locale), { reply_markup: menu(locale) });
  }
}

async function confirmApiKeyCreate(ctx: Context, deps: BotDependencies, profileIndex: number): Promise<void> {
  if (!isPrivate(ctx) || !ctx.from) return void (await ctx.reply(privateOnly));
  if (deps.config.newApiIntegrationMode !== 'bridge') return showOfficialApiPortal(ctx, deps);
  const locale = localeFor(ctx);
  try {
    const access = await deps.newApi.getApiAccess(String(ctx.from.id));
    const profile = access.profiles[profileIndex];
    if (!profile) {
      await ctx.reply(locale === 'en' ? 'That key profile is no longer available.' : '所选 Key 模型分组已不可用，请重新选择。', { reply_markup: menu(locale) });
      return;
    }
    const requestId = randomUUID().replaceAll('-', '');
    const text = locale === 'en'
      ? `Create an API Key for: ${formatApiKeyProfile(profile)}\n\nThe key itself is available only on the authenticated Keys dashboard. The bot will show masked metadata only.`
      : `确认创建 API Key\n模型分组：${formatApiKeyProfile(profile)}\n\n完整 Key 仅在已登录的 Key 管理页面查看或复制；机器人只展示掩码信息。`;
    await ctx.reply(text, {
      reply_markup: new InlineKeyboard()
        .text(locale === 'en' ? 'Confirm create' : '确认创建', `keys:confirm:${profileIndex}:${requestId}`)
        .text(locale === 'en' ? 'Cancel' : '取消', 'keys').row()
        .url(locale === 'en' ? 'Keys dashboard' : 'Key 管理页面', access.keyManagementUrl),
    });
  } catch (error) {
    await ctx.reply(apiAccessUnavailableMessage(error, locale), { reply_markup: menu(locale) });
  }
}

async function createApiKey(ctx: Context, deps: BotDependencies, profileIndex: number, requestId: string): Promise<void> {
  if (!isPrivate(ctx) || !ctx.from || !/^[A-Za-z0-9_-]{16,64}$/.test(requestId)) return void (await ctx.reply(privateOnly));
  if (deps.config.newApiIntegrationMode !== 'bridge') return showOfficialApiPortal(ctx, deps);
  const locale = localeFor(ctx);
  try {
    const [access, key] = await Promise.all([
      deps.newApi.getApiAccess(String(ctx.from.id)),
      deps.newApi.createApiKey(String(ctx.from.id), profileIndex, requestId),
    ]);
    await deps.repository.writeAudit({
      actorTelegramUserId: String(ctx.from.id), action: 'api_key.created', targetType: 'new_api_token', targetId: String(key.id),
    });
    const heading = locale === 'en' ? 'API Key created' : 'API Key 已创建';
    await ctx.reply(`${heading}\n\n${formatApiKey(key, locale)}\n\n${locale === 'en' ? 'Open the authenticated dashboard to view or copy the full key.' : '请在已登录的 Key 管理页面查看或复制完整 Key。'}`, {
      reply_markup: new InlineKeyboard()
        .text(locale === 'en' ? 'Manage API Keys' : '管理 API Key', 'keys')
        .url(locale === 'en' ? 'Keys dashboard' : 'Key 管理页面', access.keyManagementUrl).row()
        .text(t(locale, 'returnToMenu'), 'menu'),
    });
  } catch (error) {
    await ctx.reply(apiAccessUnavailableMessage(error, locale), { reply_markup: menu(locale) });
  }
}

async function setApiKeyStatus(ctx: Context, deps: BotDependencies, tokenId: number, enabled: boolean): Promise<void> {
  if (!isPrivate(ctx) || !ctx.from) return void (await ctx.reply(privateOnly));
  if (deps.config.newApiIntegrationMode !== 'bridge') return showOfficialApiPortal(ctx, deps);
  const locale = localeFor(ctx);
  try {
    const key = await deps.newApi.setApiKeyStatus(String(ctx.from.id), tokenId, enabled);
    await deps.repository.writeAudit({
      actorTelegramUserId: String(ctx.from.id), action: 'api_key.status_changed', targetType: 'new_api_token', targetId: String(key.id),
    });
    const result = locale === 'en'
      ? `API Key #${key.id} is now ${apiKeyStatusLabel(locale, key.status)}.`
      : `API Key #${key.id} 已${key.status === 'enabled' ? '启用' : '停用'}。`;
    await ctx.reply(`${result}\n\n${formatApiKey(key, locale)}`, { reply_markup: new InlineKeyboard().text(locale === 'en' ? 'Back to keys' : '返回 Key 列表', 'keys').row().text(t(locale, 'returnToMenu'), 'menu') });
  } catch (error) {
    await ctx.reply(apiAccessUnavailableMessage(error, locale), { reply_markup: menu(locale) });
  }
}

async function confirmApiKeyDelete(ctx: Context, deps: BotDependencies, tokenId: number): Promise<void> {
  if (!isPrivate(ctx) || !ctx.from) return void (await ctx.reply(privateOnly));
  if (deps.config.newApiIntegrationMode !== 'bridge') return showOfficialApiPortal(ctx, deps);
  const locale = localeFor(ctx);
  try {
    const key = (await deps.newApi.listApiKeys(String(ctx.from.id))).find((candidate) => candidate.id === tokenId);
    if (!key) {
      await ctx.reply(locale === 'en' ? 'That API Key is no longer available.' : '该 API Key 已不可用，请刷新列表。', { reply_markup: menu(locale) });
      return;
    }
    await ctx.reply(`${locale === 'en' ? 'Delete this API Key permanently?' : '确认永久删除这个 API Key？'}\n\n${formatApiKey(key, locale)}`, {
      reply_markup: new InlineKeyboard()
        .text(locale === 'en' ? 'Confirm delete' : '确认删除', `keys:deleteconfirm:${key.id}`)
        .text(locale === 'en' ? 'Cancel' : '取消', 'keys').row()
        .text(t(locale, 'returnToMenu'), 'menu'),
    });
  } catch (error) {
    await ctx.reply(apiAccessUnavailableMessage(error, locale), { reply_markup: menu(locale) });
  }
}

async function deleteApiKey(ctx: Context, deps: BotDependencies, tokenId: number): Promise<void> {
  if (!isPrivate(ctx) || !ctx.from) return void (await ctx.reply(privateOnly));
  if (deps.config.newApiIntegrationMode !== 'bridge') return showOfficialApiPortal(ctx, deps);
  const locale = localeFor(ctx);
  try {
    await deps.newApi.deleteApiKey(String(ctx.from.id), tokenId);
    await deps.repository.writeAudit({
      actorTelegramUserId: String(ctx.from.id), action: 'api_key.deleted', targetType: 'new_api_token', targetId: String(tokenId),
    });
    await ctx.reply(locale === 'en' ? `API Key #${tokenId} has been deleted.` : `API Key #${tokenId} 已删除。`, {
      reply_markup: new InlineKeyboard().text(locale === 'en' ? 'Back to keys' : '返回 Key 列表', 'keys').row().text(t(locale, 'returnToMenu'), 'menu'),
    });
  } catch (error) {
    await ctx.reply(apiAccessUnavailableMessage(error, locale), { reply_markup: menu(locale) });
  }
}

function parseTopUpAmount(value: string | undefined): number | undefined {
  if (!value || !/^\d{1,15}$/.test(value)) return undefined;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : undefined;
}

function formatTopUpAmount(amount: number, displayType: TopUpOptions['displayType']): string {
  if (displayType === 'TOKENS') return `${amount.toLocaleString()} tokens`;
  if (displayType === 'USD') return `$${amount.toLocaleString()}`;
  if (displayType === 'CNY') return `¥${amount.toLocaleString()}`;
  return amount.toLocaleString();
}

function topUpMethodMinimum(options: TopUpOptions, method: TopUpPaymentMethod): number {
  return Math.max(options.minTopup, method.minTopup ?? 0);
}

function topUpUnavailableMessage(error?: unknown): string {
  if (error instanceof NewApiError && error.code === 'api' && error.message === 'telegram account is not bound') {
    return '请先在 new-api 网页完成 Telegram 绑定后再充值。';
  }
  if (error instanceof NewApiError && error.code === 'config') {
    return '充值功能需要 Bridge 集成配置。';
  }
  return '充值暂不可用，请稍后重试。';
}

async function showOfficialTopUpPortal(ctx: Context, deps: BotDependencies): Promise<void> {
  const locale = localeFor(ctx);
  const text = locale === 'en'
    ? 'Top up\n\nThis Bot is connected through official new-api APIs. Payment initiation and payment status are handled in the authenticated web portal, so the Bot does not collect payment details, wallet addresses, or transaction hashes.'
    : '充值中心\n\n当前 Bot 使用原生 new-api 接口。支付建单与到账状态仅在已登录的网页账户中心处理，机器人不会收集支付凭证、钱包地址或交易哈希。';
  await ctx.reply(text, {
    reply_markup: new InlineKeyboard()
      .url(locale === 'en' ? 'Open top-up portal' : '打开充值页面', deps.config.newApiTopupUrl)
      .url(locale === 'en' ? 'Open account portal' : '打开账户中心', deps.config.newApiPortalUrl).row()
      .text(t(locale, 'returnToMenu'), 'menu'),
  });
}

async function getTopUpOptions(ctx: Context, deps: BotDependencies): Promise<TopUpOptions | null> {
  if (deps.config.newApiIntegrationMode !== 'bridge') {
    await showOfficialTopUpPortal(ctx, deps);
    return null;
  }
  if (!ctx.from) return null;
  try {
    const options = await deps.newApi.getTopUpOptions(String(ctx.from.id));
    if (!options.enabled || options.paymentMethods.length === 0) {
      await ctx.reply('充值暂未开放，请稍后重试。', { reply_markup: menu() });
      return null;
    }
    return options;
  } catch (error) {
    await ctx.reply(topUpUnavailableMessage(error), { reply_markup: menu() });
    return null;
  }
}

async function handleTopUp(ctx: Context, deps: BotDependencies, requestedAmount?: number): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  if (deps.config.newApiIntegrationMode !== 'bridge') return showOfficialTopUpPortal(ctx, deps);
  const options = await getTopUpOptions(ctx, deps);
  if (!options) return;
  if (requestedAmount !== undefined) {
    if (requestedAmount < options.minTopup) {
      await ctx.reply(`充值金额不能低于 ${formatTopUpAmount(options.minTopup, options.displayType)}。`, { reply_markup: menu() });
      return;
    }
    await showTopUpMethods(ctx, options, requestedAmount);
    return;
  }

  const amounts = [...new Set(options.amountOptions.filter((amount) => amount >= options.minTopup))]
    .filter((amount) => Number.isSafeInteger(amount) && amount > 0)
    .slice(0, 10);
  const keyboard = new InlineKeyboard();
  for (let index = 0; index < amounts.length; index += 1) {
    const amount = amounts[index];
    if (amount === undefined) continue;
    keyboard.text(formatTopUpAmount(amount, options.displayType), `topup:amount:${amount}`);
    if (index % 2 === 1) keyboard.row();
  }
  if (amounts.length % 2 === 1) keyboard.row();
  keyboard.text('自定义金额', 'topup:custom').row().text('返回菜单', 'menu');
  await ctx.reply(
    `充值中心\n最低充值额度：${formatTopUpAmount(options.minTopup, options.displayType)}\n请选择金额，或发送 /topup <整数金额>。`,
    { reply_markup: keyboard },
  );
}

async function showTopUpMethods(ctx: Context, options: TopUpOptions, amount: number): Promise<void> {
  const available = options.paymentMethods.filter((method) => amount >= topUpMethodMinimum(options, method));
  if (available.length === 0) {
    await ctx.reply('所选金额未满足当前支付方式的最低限制，请选择更高金额。', { reply_markup: menu() });
    return;
  }
  const keyboard = new InlineKeyboard();
  for (const method of available) {
    if (method.type === 'crypto') {
      keyboard.text(method.name, `topup:crypto:${amount}`);
    } else {
      keyboard.text(method.name, `topup:quote:${amount}:${method.type}`);
    }
  }
  keyboard.row().text('重新选择金额', 'topup').text('取消', 'topup:cancel');
  await ctx.reply(`充值额度：${formatTopUpAmount(amount, options.displayType)}\n请选择支付方式：`, { reply_markup: keyboard });
}

async function showCryptoAssets(ctx: Context, options: TopUpOptions | null, amount: number): Promise<void> {
  if (!options) return;
  const crypto = options.paymentMethods.find((method) => method.type === 'crypto');
  if (!crypto || amount < topUpMethodMinimum(options, crypto) || !crypto.cryptoNetworks) {
    await ctx.reply('链上充值暂时不可用，请重新选择支付方式。', { reply_markup: menu() });
    return;
  }
  const assets = [...new Set(crypto.cryptoNetworks.flatMap((network) => network.assets))];
  const keyboard = new InlineKeyboard();
  for (const asset of assets) keyboard.text(asset, `topup:crypto:asset:${amount}:${asset}`);
  keyboard.row().text('重新选择支付方式', `topup:amount:${amount}`).text('取消', 'topup:cancel');
  await ctx.reply(`链上充值\n充值额度：${formatTopUpAmount(amount, options.displayType)}\n请选择稳定币：`, { reply_markup: keyboard });
}

async function showCryptoNetworks(
  ctx: Context,
  options: TopUpOptions | null,
  amount: number,
  asset: CryptoAsset,
): Promise<void> {
  if (!options) return;
  const crypto = options.paymentMethods.find((method) => method.type === 'crypto');
  const networks = crypto?.cryptoNetworks?.filter((network) => network.assets.includes(asset)) ?? [];
  if (networks.length === 0) {
    await ctx.reply('所选稳定币当前没有可用网络，请重新选择。', { reply_markup: menu() });
    return;
  }
  const keyboard = new InlineKeyboard();
  for (const network of networks) {
    keyboard.text(network.name, `topup:crypto:network:${amount}:${asset}:${network.network}`).row();
  }
  keyboard.text('重新选择稳定币', `topup:crypto:${amount}`).text('取消', 'topup:cancel');
  await ctx.reply(`${asset} 链上充值\n请选择网络。请务必使用页面显示的网络，跨链转账无法自动入账。`, { reply_markup: keyboard });
}

async function handleTopUpQuote(
  ctx: Context,
  deps: BotDependencies,
  amount: number,
  paymentMethod: TopUpPaymentMethod['type'],
  crypto?: { asset: CryptoAsset; network: CryptoNetwork },
): Promise<void> {
  if (!isPrivate(ctx) || !ctx.from) return void (await ctx.reply(privateOnly));
  const options = await getTopUpOptions(ctx, deps);
  if (!options) return;
  const method = options.paymentMethods.find((candidate) => candidate.type === paymentMethod);
  const network = crypto && method?.cryptoNetworks?.find((candidate) => candidate.network === crypto.network && candidate.assets.includes(crypto.asset));
  if (!method || amount < topUpMethodMinimum(options, method) || (paymentMethod === 'crypto' && !network)) {
    await ctx.reply('支付方式或金额已变化，请重新选择。', { reply_markup: menu() });
    return;
  }
  try {
    const quote = await deps.newApi.quoteTopUp(String(ctx.from.id), amount, paymentMethod, crypto);
    if (quote.topupAmount !== amount || quote.paymentMethod !== paymentMethod
      || (crypto && (quote.cryptoAsset !== crypto.asset || quote.cryptoNetwork !== crypto.network))) {
      throw new NewApiError('contract', 'new-api topup quote does not match the requested payment');
    }
    const expiresMinutes = Math.max(1, Math.ceil(quote.expiresIn / 60));
    const methodDetails = crypto && network
      ? `${method.name}\n稳定币：${crypto.asset}\n网络：${network.name}`
      : method.name;
    const createCallback = crypto
      ? `topup:crypto:create:${amount}:${crypto.asset}:${crypto.network}`
      : `topup:create:${amount}:${paymentMethod}`;
    await ctx.reply(
      `确认充值\n充值额度：${formatTopUpAmount(quote.topupAmount, options.displayType)}\n支付方式：${methodDetails}\n实际支付金额：${quote.payableAmount}${crypto ? ` ${crypto.asset}` : ''}\n报价有效期：约 ${expiresMinutes} 分钟\n\n确认后会创建待支付订单。`,
      {
        reply_markup: new InlineKeyboard()
          .text('确认创建订单', createCallback).text('取消', 'topup:cancel').row()
          .text('返回充值中心', 'topup'),
      },
    );
  } catch (error) {
    await ctx.reply(topUpUnavailableMessage(error), { reply_markup: menu() });
  }
}

async function handleTopUpOrderCreate(
  ctx: Context,
  deps: BotDependencies,
  amount: number,
  paymentMethod: TopUpPaymentMethod['type'],
  crypto?: { asset: CryptoAsset; network: CryptoNetwork },
): Promise<void> {
  if (!isPrivate(ctx) || !ctx.from || !ctx.callbackQuery) return void (await ctx.reply(privateOnly));
  const idempotencyKey = ctx.callbackQuery.id;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey)) {
    await ctx.reply('无法安全创建订单，请重新确认充值。', { reply_markup: menu() });
    return;
  }
  const options = await getTopUpOptions(ctx, deps);
  if (!options) return;
  const method = options.paymentMethods.find((candidate) => candidate.type === paymentMethod);
  const network = crypto && method?.cryptoNetworks?.find((candidate) => candidate.network === crypto.network && candidate.assets.includes(crypto.asset));
  if (!method || amount < topUpMethodMinimum(options, method) || (paymentMethod === 'crypto' && !network)) {
    await ctx.reply('支付方式或金额已变化，请重新选择。', { reply_markup: menu() });
    return;
  }
  try {
    const order = await deps.newApi.createTopUp(String(ctx.from.id), amount, paymentMethod, idempotencyKey, crypto);
    if (order.topupAmount !== amount || order.paymentMethod !== paymentMethod
      || (crypto && (order.cryptoAsset !== crypto.asset || order.cryptoNetwork !== crypto.network))) {
      throw new NewApiError('contract', 'new-api topup order does not match the requested payment');
    }
    if (order.status !== 'pending') {
      await handleTopUpStatus(ctx, deps, order.orderRef);
      return;
    }
    if (order.checkoutUrl) {
      await sendTopUpCheckout(ctx, deps, order, options.displayType);
    } else {
      await sendCryptoTopUp(ctx, deps, order, options.displayType);
    }
  } catch (error) {
    await ctx.reply(topUpUnavailableMessage(error), { reply_markup: menu() });
  }
}

async function sendTopUpCheckout(
  ctx: Context,
  deps: BotDependencies,
  order: TopUpOrder,
  displayType: TopUpOptions['displayType'],
): Promise<void> {
  if (!order.checkoutUrl) throw new NewApiError('contract', 'checkout order is missing a checkout URL');
  const expiresAt = formatTimestamp(order.expiresAt);
  const keyboard = new InlineKeyboard()
    .url('打开支付页面', order.checkoutUrl).row()
    .text('查询状态', `topup:status:${order.orderRef}`).text('充值中心', 'topup');
  await ctx.reply(
    `待支付订单已创建\n订单状态：等待支付\n充值额度：${formatTopUpAmount(order.topupAmount, displayType)}\n实际支付金额：${order.payableAmount}\n支付页面有效至：${expiresAt}`,
    { reply_markup: keyboard },
  );
  try {
    const qrCode = await createCheckoutQr(order.checkoutUrl);
    await ctx.replyWithPhoto(new InputFile(qrCode, 'checkout.png'), {
      caption: '扫描二维码打开支付页面。',
      reply_markup: keyboard,
    });
  } catch (error) {
    deps.logger.warn({ err: error }, 'checkout QR delivery failed');
    await ctx.reply('二维码暂时无法发送，请使用上方按钮打开支付页面。');
  }
}

async function sendCryptoTopUp(
  ctx: Context,
  deps: BotDependencies,
  order: TopUpOrder,
  displayType: TopUpOptions['displayType'],
): Promise<void> {
  if (!order.cryptoAsset || !order.cryptoNetwork || !order.depositAddress || !order.requiredConfirmations) {
    throw new NewApiError('contract', 'crypto order is incomplete');
  }
  const networkName = cryptoNetworkLabel(order.cryptoNetwork);
  const memo = order.depositMemo ? `\nMemo：${order.depositMemo}` : '';
  const keyboard = new InlineKeyboard()
    .text('查询状态', `topup:status:${order.orderRef}`).text('充值中心', 'topup');
  await ctx.reply(
    `链上充值订单已创建\n充值额度：${formatTopUpAmount(order.topupAmount, displayType)}\n转账金额：${order.payableAmount} ${order.cryptoAsset}\n网络：${networkName}\n收款地址：\n${order.depositAddress}${memo}\n确认要求：${order.requiredConfirmations} 个区块确认\n有效至：${formatTimestamp(order.expiresAt)}\n\n请复制地址，并只通过所选网络转入所选币种。Mock 地址不会接收或入账真实资金。`,
    { reply_markup: keyboard },
  );
}

async function handleTopUpStatus(ctx: Context, deps: BotDependencies, orderRef: string): Promise<void> {
  if (!isPrivate(ctx) || !ctx.from) return void (await ctx.reply(privateOnly));
  try {
    const status = await deps.newApi.getTopUpStatus(String(ctx.from.id), orderRef);
    await ctx.reply(formatTopUpStatus(status), { reply_markup: topUpStatusKeyboard(status) });
  } catch (error) {
    await ctx.reply(topUpUnavailableMessage(error), { reply_markup: menu() });
  }
}

function formatTopUpStatus(status: TopUpStatus): string {
  const statusText: Record<TopUpStatus['status'], string> = {
    pending: '等待支付',
    processing: '正在确认',
    success: '充值已到账',
    failed: '支付失败',
    expired: '支付链接已过期',
  };
  const lines = [
    `充值状态：${statusText[status.status]}`,
    `支付方式：${status.paymentMethod === 'alipay' ? '支付宝' : status.paymentMethod === 'wxpay' ? '微信支付' : '链上稳定币'}`,
    `实际支付金额：${status.payableAmount}${status.cryptoAsset ? ` ${status.cryptoAsset}` : ''}`,
    `创建时间：${formatTimestamp(status.createdAt)}`,
  ];
  if (status.cryptoNetwork) lines.push(`网络：${cryptoNetworkLabel(status.cryptoNetwork)}`);
  if (status.requiredConfirmations) lines.push(`确认要求：${status.requiredConfirmations} 个区块确认`);
  if (status.completedAt) lines.push(`完成时间：${formatTimestamp(status.completedAt)}`);
  if (status.status === 'pending') lines.push(`支付页面有效至：${formatTimestamp(status.expiresAt)}`);
  return lines.join('\n');
}

function cryptoNetworkLabel(network: CryptoNetwork): string {
  const labels: Record<CryptoNetwork, string> = {
    bsc: 'BNB Smart Chain (BEP-20)',
    ethereum: 'Ethereum (ERC-20)',
    base: 'Base',
    solana: 'Solana',
  };
  return labels[network];
}

function topUpStatusKeyboard(status: TopUpStatus): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (status.status === 'pending' || status.status === 'processing') {
    keyboard.text('刷新状态', `topup:status:${status.orderRef}`).row();
  }
  if (status.status === 'failed' || status.status === 'expired') {
    keyboard.text('重新充值', 'topup').row();
  }
  return keyboard.text('返回菜单', 'menu');
}

export async function createCheckoutQr(checkoutUrl: string): Promise<Buffer> {
  return QRCode.toBuffer(checkoutUrl, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 640,
  });
}

async function handleUnbind(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  const identity = telegramUserFromContext(ctx);
  if (!identity) return;
  const locale = localeFor(ctx);
  await deps.repository.revokeBinding(identity.telegramUserId);
  const preference = await deps.repository.getNotificationPreference(identity.telegramUserId);
  await deps.repository.saveNotificationPreference({
    ...preference,
    lowQuotaThreshold: undefined,
    paused: true,
    updatedAt: new Date(),
  });
  await deps.repository.writeAudit({ actorTelegramUserId: identity.telegramUserId, action: 'binding.revoked' });
  await ctx.reply(locale === 'en' ? 'The Bot-side account link was removed. The Telegram login link in new-api was not changed.' : '已解除机器人侧绑定。new-api 中的 Telegram 登录绑定不会被自动解除。', { reply_markup: menu(locale) });
}

async function resolveBoundAccount(ctx: Context, deps: BotDependencies): Promise<NewApiAccount | null> {
  const identity = telegramUserFromContext(ctx);
  if (!identity) return null;
  const binding = await deps.repository.getBinding(identity.telegramUserId);
  try {
    if (deps.config.newApiIntegrationMode === 'bridge') {
      const account = await deps.newApi.resolveAccountByTelegramId(identity.telegramUserId);
      if (!binding || binding.newApiUserId !== account.id) await saveBinding(ctx, deps, account);
      return account;
    }
    if (!binding) {
      const locale = localeFor(ctx);
      await ctx.reply(locale === 'en' ? 'No account is linked yet. Link an account first.' : '还没有绑定账号，请先完成绑定。', { reply_markup: menu(locale) });
      return null;
    }
    const account = await deps.newApi.getAccountById(binding.newApiUserId);
    if (account.telegramId !== identity.telegramUserId) {
      await deps.repository.revokeBinding(identity.telegramUserId);
      const locale = localeFor(ctx);
      await ctx.reply(locale === 'en' ? 'The account link is no longer valid. Link it again.' : '账号绑定已失效，请重新绑定。', { reply_markup: menu(locale) });
      return null;
    }
    await deps.repository.saveBinding({ ...binding, usernameSnapshot: account.username, lastVerifiedAt: new Date() });
    return account;
  } catch (error) {
    const locale = localeFor(ctx);
    await ctx.reply(userFacingError(error, locale), { reply_markup: menu(locale) });
    return null;
  }
}

async function saveBinding(ctx: Context, deps: BotDependencies, account: NewApiAccount): Promise<void> {
  const identity = telegramUserFromContext(ctx);
  if (!identity || account.telegramId !== identity.telegramUserId) {
    throw new NewApiError('api', 'telegram identity mismatch');
  }
  const now = new Date();
  await deps.repository.saveBinding({
    telegramUserId: identity.telegramUserId,
    newApiUserId: account.id,
    usernameSnapshot: account.username,
    status: 'active',
    verifiedAt: now,
    lastVerifiedAt: now,
  });
  await deps.repository.writeAudit({
    actorTelegramUserId: identity.telegramUserId,
    action: 'binding.created',
    targetType: 'new_api_user',
    targetId: String(account.id),
  });
}

async function getStatus(deps: BotDependencies): Promise<NewApiStatus> {
  return deps.newApi.getStatus();
}

function bindFailureMessage(error: unknown, bridge: boolean, locale: Locale = 'zh'): string {
  if (error instanceof NewApiError && (error.code === 'http' || error.code === 'api')) {
    return bridge
      ? locale === 'en' ? 'No linked new-api account was found. Link Telegram on the website, then try again.' : '暂未找到已绑定的 new-api 账号，请先在网页完成 Telegram 绑定后重试。'
      : locale === 'en' ? 'The account could not be verified. Please try again later.' : '无法验证账号，请稍后重试。';
  }
  return userFacingError(error, locale);
}

function userFacingError(error: unknown, locale: Locale = 'zh'): string {
  if (error instanceof NewApiError) {
    if (error.code === 'timeout') return locale === 'en' ? 'new-api timed out. Please try again.' : 'new-api 响应超时，请稍后重试。';
    if (error.code === 'contract') return locale === 'en' ? 'The new-api response is incompatible with this Bot version. Please contact support.' : 'new-api 接口版本不兼容，请联系管理员。';
    if (error.code === 'config') return locale === 'en' ? 'The Bot integration is incomplete. Please contact support.' : '机器人集成配置不完整，请联系管理员。';
  }
  return locale === 'en' ? 'This action is temporarily unavailable. Please try again.' : '暂时无法完成操作，请稍后重试。';
}
