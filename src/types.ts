export type TelegramUser = {
  telegramUserId: string;
  chatId: string;
  username?: string;
  displayName?: string;
  locale: 'zh' | 'en';
};

export type AccountBinding = {
  telegramUserId: string;
  newApiUserId: number;
  usernameSnapshot: string;
  status: 'active' | 'revoked';
  verifiedAt: Date;
  lastVerifiedAt: Date;
};

export type NotificationPreference = {
  telegramUserId: string;
  lowQuotaThreshold?: number | undefined;
  subscriptionNoticeDays: number;
  paused: boolean;
  updatedAt: Date;
};

export type ActiveBinding = {
  user: TelegramUser;
  binding: AccountBinding;
};

export type SupportTicket = {
  id: number;
  ticketNo: string;
  telegramUserId: string;
  chatId: string;
  opsChatId: string;
  opsMessageId: number;
  status: 'open' | 'closed';
  createdAt: Date;
  closedAt?: Date;
};

export type BotAuditMetadata = {
  threshold?: number;
  targetCount?: number;
  delivered?: number;
  failed?: number;
};

export type RepositoryStats = {
  telegramUsers: number;
  activeBindings: number;
  openTickets: number;
};

export type NewApiAccount = {
  id: number;
  username: string;
  displayName?: string;
  telegramId?: string;
  status: number;
  group?: string;
  quota: number;
  usedQuota: number;
  requestCount?: number;
};

export type NewApiStatus = {
  version?: string;
  quotaPerUnit: number;
  quotaDisplayType: 'USD' | 'CNY' | 'TOKENS' | 'CUSTOM';
  customCurrencySymbol?: string;
  customCurrencyExchangeRate?: number;
  usdExchangeRate?: number;
  systemName?: string;
};

export type UsageStat = {
  quota: number;
  rpm?: number;
  tpm?: number;
};

export type Subscription = {
  id?: number;
  planId?: number;
  planName?: string;
  status?: string;
  startTime?: number;
  endTime?: number;
  amount?: number;
  usedAmount?: number;
  remainingAmount?: number;
};

export interface BotRepository {
  init(): Promise<void>;
  close(): Promise<void>;
  claimUpdate(updateId: number): Promise<boolean>;
  upsertTelegramUser(user: TelegramUser): Promise<void>;
  getBinding(telegramUserId: string): Promise<AccountBinding | null>;
  saveBinding(binding: AccountBinding): Promise<void>;
  revokeBinding(telegramUserId: string): Promise<void>;
  getNotificationPreference(telegramUserId: string): Promise<NotificationPreference>;
  saveNotificationPreference(preference: NotificationPreference): Promise<void>;
  claimNotificationEvent(eventKey: string, telegramUserId: string, kind: string): Promise<boolean>;
  clearNotificationEvent(eventKey: string): Promise<void>;
  listActiveBindings(): Promise<ActiveBinding[]>;
  createSupportTicket(input: {
    telegramUserId: string;
    chatId: string;
    opsChatId: string;
    opsMessageId: number;
  }): Promise<SupportTicket>;
  findSupportTicketByOpsMessage(opsChatId: string, opsMessageId: number): Promise<SupportTicket | null>;
  closeSupportTicket(ticketNo: string): Promise<void>;
  getStats(): Promise<RepositoryStats>;
  writeAudit(input: {
    actorTelegramUserId?: string;
    action: string;
    targetType?: string;
    targetId?: string;
    metadata?: BotAuditMetadata;
  }): Promise<void>;
}
