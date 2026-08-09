export type Locale = 'zh' | 'en';

type MessageKey =
  | 'bind'
  | 'account'
  | 'usage'
  | 'subscription'
  | 'topup'
  | 'models'
  | 'apiAccess'
  | 'notice'
  | 'settings'
  | 'support'
  | 'help'
  | 'unbind'
  | 'language'
  | 'website'
  | 'docs'
  | 'modelSquare'
  | 'returnToMenu'
  | 'privateOnly'
  | 'languageTitle'
  | 'languageSaved'
  | 'helpHint';

const copy: Record<Locale, Record<MessageKey, string>> = {
  zh: {
    bind: '绑定账号',
    account: '账户余额',
    usage: '用量统计',
    subscription: '订阅状态',
    topup: '充值中心',
    models: '可用模型',
    apiAccess: 'API 接入',
    notice: '最新公告',
    settings: '通知设置',
    support: '联系客服',
    help: '帮助',
    unbind: '解绑',
    language: '语言',
    website: '官网',
    docs: '使用文档',
    modelSquare: '模型广场',
    returnToMenu: '返回菜单',
    privateOnly: '请在与机器人的私聊中执行此操作。',
    languageTitle: '选择语言',
    languageSaved: '语言已切换为中文。',
    helpHint: '请选择一个操作，或发送 /help 查看命令。',
  },
  en: {
    bind: 'Link account',
    account: 'Account balance',
    usage: 'Usage',
    subscription: 'Subscription',
    topup: 'Top up',
    models: 'Available models',
    apiAccess: 'API access',
    notice: 'Announcements',
    settings: 'Notifications',
    support: 'Support',
    help: 'Help',
    unbind: 'Unlink',
    language: 'Language',
    website: 'Website',
    docs: 'Documentation',
    modelSquare: 'Model Square',
    returnToMenu: 'Back to menu',
    privateOnly: 'Please use this feature in a private chat with the bot.',
    languageTitle: 'Choose language',
    languageSaved: 'Language switched to English.',
    helpHint: 'Choose an action, or send /help to view commands.',
  },
};

export function t(locale: Locale, key: MessageKey): string {
  return copy[locale][key];
}

export function welcomeMessage(locale: Locale, displayName?: string): string {
  if (locale === 'en') {
    return [
      `Welcome${displayName ? `, ${displayName}` : ''} to SuperToken.`,
      '',
      'One key connects you to leading AI models worldwide.',
      'GPT, Claude, Gemini, image and video models through compatible APIs.',
      '',
      'Link your SuperToken account to view your balance, usage, subscriptions, available models, and top-up options.',
    ].join('\n');
  }
  return [
    `${displayName ? `${displayName}，` : ''}欢迎使用 SuperToken。`,
    '',
    '一个 Key，连接全球主流 AI 模型。',
    '统一接入 GPT、Claude、Gemini，以及图片、视频模型，兼容主流 API 格式。',
    '',
    '绑定 SuperToken 账号后，可查询余额、用量、订阅、可用模型和充值入口。',
  ].join('\n');
}

export function localeFromTelegramLanguage(languageCode: string | undefined): Locale {
  return languageCode?.toLowerCase().startsWith('en') ? 'en' : 'zh';
}
