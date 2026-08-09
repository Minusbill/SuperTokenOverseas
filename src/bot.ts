import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { NewApiClient } from './new-api.js';
import { NewApiError } from './new-api.js';
import { sendMessageWithRetry } from './telegram.js';
import {
  formatNotificationPreference,
  formatNotice,
  formatQuota,
  formatRepositoryStats,
  formatSubscriptions,
  formatTimestamp,
  formatUsage,
} from './format.js';
import type { BotRepository, NewApiAccount, NewApiStatus, NotificationPreference } from './types.js';

const privateOnly = '请在与机器人的私聊中执行此操作。';

function menu(): InlineKeyboard {
  return new InlineKeyboard()
    .text('绑定账号', 'bind').text('账户余额', 'account').row()
    .text('用量统计', 'usage').text('订阅状态', 'subscription').row()
    .text('最新公告', 'notice').text('通知设置', 'settings').row()
    .text('联系客服', 'support').text('帮助', 'help').row()
    .text('解绑', 'unbind');
}

const pendingBroadcasts = new Map<string, string>();
type UsageRange = '24h' | 'today' | '7d' | '30d';
const sensitiveSupportContent = /(?:\b(?:authorization|bearer|api[-_ ]?key|password|cvv)\b|sk-[\w-]{8,}|密码|密钥|验证码|(?:\d[ -]?){13,19})/i;

function isPrivate(ctx: Context): boolean {
  return ctx.chat?.type === 'private';
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
    locale: user.language_code?.toLowerCase().startsWith('en') ? ('en' as const) : ('zh' as const),
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
    if (user) await deps.repository.upsertTelegramUser(user);
    await next();
  });

  bot.catch((error) => {
    deps.logger.error({ err: error.error, updateId: error.ctx.update.update_id }, 'telegram update failed');
  });

  bot.command('start', async (ctx) => {
    await ctx.reply('欢迎使用中转站服务机器人。请选择操作：', { reply_markup: menu() });
  });

  bot.command('help', async (ctx) => {
    const bindHelp = deps.config.newApiIntegrationMode === 'bridge'
      ? '/bind 绑定账号（Bridge 模式）'
      : '/bind <用户ID> 绑定账号（临时 admin 模式）';
    await ctx.reply(
      `可用功能：\n${bindHelp}\n/account 查看账户\n/usage [today|7d|30d] 查看用量\n/subscription 查看订阅\n/notice 查看公告\n/settings 查看通知设置\n/notify <额度|off|pause|resume> 修改通知\n/support <问题> 联系客服（不要提供密钥、密码或支付凭证）\n/unbind 解除机器人绑定`,
      { reply_markup: menu() },
    );
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
    if (!isPrivate(ctx) || !ctx.from) return void (await ctx.reply(privateOnly));
    await ctx.reply(`你的 Telegram ID：${ctx.from.id}`);
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
    if (!isPrivate(ctx)) return ctx.reply(privateOnly);
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
  bot.callbackQuery('help', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply('请使用私聊完成账号绑定，再查询余额、用量和订阅。', { reply_markup: menu() });
  });
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

function isAdmin(ctx: Context, deps: BotDependencies): boolean {
  return Boolean(ctx.from && deps.config.botAdminTelegramIds.has(String(ctx.from.id)));
}

function normalizeUsageRange(value: string | undefined): UsageRange {
  if (value === 'today' || value === '7d' || value === '30d') return value;
  return '24h';
}

function usageWindow(range: UsageRange, end: number): { start: number; title: string } {
  if (range === 'today') {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(end * 1000));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const start = Math.floor((Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)) - 8 * 3600000) / 1000);
    return { start, title: '今日用量' };
  }
  if (range === '7d') return { start: end - 7 * 24 * 60 * 60, title: '近 7 天用量' };
  if (range === '30d') return { start: end - 30 * 24 * 60 * 60, title: '近 30 天用量' };
  return { start: end - 24 * 60 * 60, title: '近 24 小时用量' };
}

async function handleNotice(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  try {
    await ctx.reply(formatNotice(await deps.newApi.getNotice()), { reply_markup: menu() });
  } catch (error) {
    await ctx.reply(userFacingError(error), { reply_markup: menu() });
  }
}

async function handleSettings(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  const identity = telegramUserFromContext(ctx);
  if (!identity) return;
  try {
    const preference = await deps.repository.getNotificationPreference(identity.telegramUserId);
    const keyboard = new InlineKeyboard()
      .text(preference.paused ? '恢复通知' : '暂停通知', 'settings:pause')
      .text('关闭低余额提醒', 'settings:clear').row()
      .text('帮助：/notify 100000', 'help');
    await ctx.reply(`${formatNotificationPreference(preference)}\n\n使用 /notify <额度> 设置低余额阈值。`, {
      reply_markup: keyboard,
    });
  } catch (error) {
    await ctx.reply(userFacingError(error), { reply_markup: menu() });
  }
}

async function handleNotify(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  const identity = telegramUserFromContext(ctx);
  if (!identity) return;
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
    await ctx.reply(formatNotificationPreference(updated), { reply_markup: menu() });
    return;
  }
  if (argument === 'off') {
    const updated: NotificationPreference = { ...preference, lowQuotaThreshold: undefined, updatedAt: new Date() };
    await deps.repository.saveNotificationPreference(updated);
    await deps.repository.writeAudit({ actorTelegramUserId: identity.telegramUserId, action: 'notification.threshold_cleared' });
    await ctx.reply(formatNotificationPreference(updated), { reply_markup: menu() });
    return;
  }
  const threshold = Number(argument);
  if (!Number.isSafeInteger(threshold) || threshold < 0) {
    await ctx.reply('格式：/notify 100000、/notify off、/notify pause 或 /notify resume');
    return;
  }
  const updated: NotificationPreference = { ...preference, lowQuotaThreshold: threshold, updatedAt: new Date() };
  await deps.repository.saveNotificationPreference(updated);
  await deps.repository.writeAudit({
    actorTelegramUserId: identity.telegramUserId,
    action: 'notification.threshold_set',
    metadata: { threshold },
  });
  await ctx.reply(formatNotificationPreference(updated), { reply_markup: menu() });
}

async function toggleNotificationPause(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  const identity = telegramUserFromContext(ctx);
  if (!identity) return;
  const preference = await deps.repository.getNotificationPreference(identity.telegramUserId);
  const updated = { ...preference, paused: !preference.paused, updatedAt: new Date() };
  await deps.repository.saveNotificationPreference(updated);
  await ctx.reply(formatNotificationPreference(updated), { reply_markup: menu() });
}

async function clearNotificationThreshold(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  const identity = telegramUserFromContext(ctx);
  if (!identity) return;
  const preference = await deps.repository.getNotificationPreference(identity.telegramUserId);
  const updated: NotificationPreference = { ...preference, lowQuotaThreshold: undefined, updatedAt: new Date() };
  await deps.repository.saveNotificationPreference(updated);
  await ctx.reply(formatNotificationPreference(updated), { reply_markup: menu() });
}

async function handleSupport(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  if (!deps.config.supportChatId) {
    await ctx.reply('客服入口尚未配置，请稍后重试。', { reply_markup: menu() });
    return;
  }
  const identity = telegramUserFromContext(ctx);
  if (!identity) return;
  const message = ctx.match?.toString().trim() ?? '';
  if (!message) {
    await ctx.reply('请使用 /support 加上你的问题，例如：/support 无法登录。请勿提供密钥、密码或支付凭证。', { reply_markup: menu() });
    return;
  }
  const safeMessage = message.length > 3500 ? `${message.slice(0, 3497)}...` : message;
  if (sensitiveSupportContent.test(safeMessage)) {
    await ctx.reply('请勿通过机器人发送密钥、密码、验证码或支付凭证。请删除敏感信息后仅描述问题。', { reply_markup: menu() });
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
    await ctx.reply(`工单已提交：${ticket.ticketNo}\n客服会在此对话回复你。`, { reply_markup: menu() });
  } catch (error) {
    deps.logger.warn({ err: error }, 'support ticket creation failed');
    await ctx.reply('工单暂时提交失败，请稍后重试。', { reply_markup: menu() });
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
  try {
    await ctx.reply(formatRepositoryStats(await deps.repository.getStats()));
  } catch (error) {
    await ctx.reply(userFacingError(error));
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
  const argument = ctx.match?.toString().trim() ?? '';
  if (deps.config.newApiIntegrationMode === 'bridge' && argument) {
    await ctx.reply('当前已启用 Telegram Bridge，请直接发送 /bind，不需要填写 new-api 用户 ID。');
    return;
  }
  if (deps.config.newApiIntegrationMode === 'bridge' && !argument) {
    try {
      const account = await deps.newApi.resolveAccountByTelegramId(identity.telegramUserId);
      await saveBinding(ctx, deps, account);
      await ctx.reply('账号绑定成功。', { reply_markup: menu() });
    } catch (error) {
      await ctx.reply(bindFailureMessage(error, true));
    }
    return;
  }
  const userId = Number(argument);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    await ctx.reply('请输入有效的 new-api 用户 ID，例如：/bind 123');
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
      await ctx.reply('绑定失败，请确认你已在 new-api 账号中绑定当前 Telegram。');
      return;
    }
    await saveBinding(ctx, deps, account);
    await ctx.reply('账号绑定成功。', { reply_markup: menu() });
  } catch (error) {
    await ctx.reply(bindFailureMessage(error, false));
  }
}

async function handleAccount(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  try {
    const account = await resolveBoundAccount(ctx, deps);
    if (!account) return;
    const status = await getStatus(deps);
    await ctx.reply(
      `账户：${account.displayName ?? account.username}\n用户组：${account.group ?? '-'}\n状态：${account.status === 1 ? '正常' : '不可用'}\n总额度：${formatQuota(account.quota, status)}\n已用额度：${formatQuota(account.usedQuota, status)}\n剩余额度：${formatQuota(account.quota - account.usedQuota, status)}\n请求数：${account.requestCount ?? '-'}`,
      { reply_markup: menu() },
    );
  } catch (error) {
    await ctx.reply(userFacingError(error), { reply_markup: menu() });
  }
}

async function handleUsage(ctx: Context, deps: BotDependencies, range: UsageRange): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  try {
    const account = await resolveBoundAccount(ctx, deps);
    if (!account) return;
    const status = await getStatus(deps);
    const end = Math.floor(Date.now() / 1000);
    const window = usageWindow(range, end);
    const usage = await deps.newApi.getUsage(account, window.start, end);
    await ctx.reply(`${window.title}\n${formatUsage(usage, status)}`, {
      reply_markup: new InlineKeyboard()
        .text('今日', 'usage:today').text('7 天', 'usage:7d').text('30 天', 'usage:30d').row()
        .text('返回菜单', 'help'),
    });
  } catch (error) {
    await ctx.reply(userFacingError(error), { reply_markup: menu() });
  }
}

async function handleSubscription(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  try {
    const account = await resolveBoundAccount(ctx, deps);
    if (!account) return;
    const subscriptions = await deps.newApi.getSubscriptions(account);
    await ctx.reply(formatSubscriptions(subscriptions), { reply_markup: menu() });
  } catch (error) {
    await ctx.reply(userFacingError(error), { reply_markup: menu() });
  }
}

async function handleUnbind(ctx: Context, deps: BotDependencies): Promise<void> {
  if (!isPrivate(ctx)) return void (await ctx.reply(privateOnly));
  const identity = telegramUserFromContext(ctx);
  if (!identity) return;
  await deps.repository.revokeBinding(identity.telegramUserId);
  const preference = await deps.repository.getNotificationPreference(identity.telegramUserId);
  await deps.repository.saveNotificationPreference({
    ...preference,
    lowQuotaThreshold: undefined,
    paused: true,
    updatedAt: new Date(),
  });
  await deps.repository.writeAudit({ actorTelegramUserId: identity.telegramUserId, action: 'binding.revoked' });
  await ctx.reply('已解除机器人侧绑定。new-api 中的 Telegram 登录绑定不会被自动解除。', { reply_markup: menu() });
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
      await ctx.reply('还没有绑定账号，请先完成绑定。', { reply_markup: menu() });
      return null;
    }
    const account = await deps.newApi.getAccountById(binding.newApiUserId);
    if (account.telegramId !== identity.telegramUserId) {
      await deps.repository.revokeBinding(identity.telegramUserId);
      await ctx.reply('账号绑定已失效，请重新绑定。', { reply_markup: menu() });
      return null;
    }
    await deps.repository.saveBinding({ ...binding, usernameSnapshot: account.username, lastVerifiedAt: new Date() });
    return account;
  } catch (error) {
    await ctx.reply(userFacingError(error), { reply_markup: menu() });
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

function bindFailureMessage(error: unknown, bridge: boolean): string {
  if (error instanceof NewApiError && (error.code === 'http' || error.code === 'api')) {
    return bridge
      ? '暂未找到已绑定的 new-api 账号，请先在网页完成 Telegram 绑定后重试。'
      : '无法验证账号，请稍后重试。';
  }
  return userFacingError(error);
}

function userFacingError(error: unknown): string {
  if (error instanceof NewApiError) {
    if (error.code === 'timeout') return 'new-api 响应超时，请稍后重试。';
    if (error.code === 'contract') return 'new-api 接口版本不兼容，请联系管理员。';
    if (error.code === 'config') return '机器人集成配置不完整，请联系管理员。';
  }
  return '暂时无法完成操作，请稍后重试。';
}
