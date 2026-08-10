export type TelegramUser = {
  telegramUserId: string;
  chatId: string;
  username?: string;
  displayName?: string;
  locale: import('./i18n.js').Locale;
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

export type AvailableModel = {
  id: string;
  endpointTypes: string[];
  /**
   * Anonymous catalogue pricing only. It is deliberately absent from the
   * Telegram Bridge response because that endpoint does not provide a
   * user-specific price quote.
   */
  cataloguePrice?: CataloguePrice;
};

export type CataloguePrice =
  | {
    kind: 'token';
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
  }
  | {
    kind: 'request';
    usdPerRequest: number;
  }
  | {
    kind: 'dynamic';
  };

export type AvailableModelPage = {
  models: AvailableModel[];
  total: number;
  nextCursor?: string;
};

export type ApiKeyProfile = {
  id: string;
  label: string;
  autoGroups?: string[];
};

export type ApiAccess = {
  baseUrl: string;
  keyManagementUrl: string;
  profiles: ApiKeyProfile[];
  keyLimit: number;
};

export type ApiKey = {
  id: number;
  name: string;
  maskedKey: string;
  status: 'enabled' | 'disabled' | 'expired' | 'exhausted' | 'unknown';
  group: string;
  autoGroups?: string[];
  createdAt: number;
  expiresAt: number;
};

export type CryptoAsset = 'USDT' | 'USDC';
export type CryptoNetwork = 'bsc' | 'ethereum' | 'base' | 'solana';

export type CryptoNetworkOption = {
  network: CryptoNetwork;
  name: string;
  assets: CryptoAsset[];
  requiredConfirmations: number;
};

export type TopUpPaymentMethod = {
  type: 'alipay' | 'wxpay' | 'crypto';
  name: string;
  minTopup?: number;
  cryptoNetworks?: CryptoNetworkOption[];
};

export type TopUpOptions = {
  enabled: boolean;
  displayType: NewApiStatus['quotaDisplayType'];
  minTopup: number;
  amountOptions: number[];
  paymentMethods: TopUpPaymentMethod[];
};

export type TopUpQuote = {
  topupAmount: number;
  paymentMethod: TopUpPaymentMethod['type'];
  payableAmount: string;
  expiresIn: number;
  cryptoAsset?: CryptoAsset;
  cryptoNetwork?: CryptoNetwork;
};

export type TopUpOrder = {
  orderRef: string;
  status: 'pending' | 'processing' | 'success' | 'failed' | 'expired';
  topupAmount: number;
  paymentMethod: TopUpPaymentMethod['type'];
  payableAmount: string;
  checkoutUrl?: string;
  cryptoAsset?: CryptoAsset;
  cryptoNetwork?: CryptoNetwork;
  depositAddress?: string;
  depositMemo?: string;
  requiredConfirmations?: number;
  expiresAt: number;
};

export type TopUpStatus = {
  orderRef: string;
  status: TopUpOrder['status'];
  paymentMethod: TopUpPaymentMethod['type'];
  payableAmount: string;
  cryptoAsset?: CryptoAsset;
  cryptoNetwork?: CryptoNetwork;
  requiredConfirmations?: number;
  createdAt: number;
  completedAt?: number;
  expiresAt: number;
};

export type QueuedTelegramUpdate = {
  updateId: number;
  payload: string;
  attempts: number;
};

export type BroadcastStatus = 'draft' | 'queued' | 'running' | 'paused' | 'completed' | 'cancelled';

export type Broadcast = {
  id: string;
  adminTelegramUserId: string;
  message: string;
  status: BroadcastStatus;
  targetCount: number;
  delivered: number;
  failed: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
};

export type BroadcastRecipient = {
  telegramUserId: string;
  chatId: string;
};

export type QueuedBroadcastDelivery = {
  broadcastId: string;
  telegramUserId: string;
  chatId: string;
  message: string;
  attempts: number;
};

export interface BotRepository {
  init(): Promise<void>;
  close(): Promise<void>;
  claimUpdate(updateId: number): Promise<boolean>;
  releaseUpdate(updateId: number): Promise<void>;
  enqueueTelegramUpdate(updateId: number, payload: string): Promise<boolean>;
  claimQueuedTelegramUpdate(): Promise<QueuedTelegramUpdate | null>;
  completeQueuedTelegramUpdate(updateId: number): Promise<void>;
  retryQueuedTelegramUpdate(updateId: number, retryAt: Date): Promise<'queued' | 'failed'>;
  createBroadcastDraft(input: {
    id: string;
    adminTelegramUserId: string;
    message: string;
    recipients: BroadcastRecipient[];
  }): Promise<Broadcast>;
  getBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null>;
  queueBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null>;
  pauseBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null>;
  resumeBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null>;
  cancelBroadcast(broadcastId: string, adminTelegramUserId: string): Promise<Broadcast | null>;
  claimBroadcastDelivery(): Promise<QueuedBroadcastDelivery | null>;
  completeBroadcastDelivery(broadcastId: string, telegramUserId: string): Promise<void>;
  retryBroadcastDelivery(broadcastId: string, telegramUserId: string, retryAt: Date): Promise<'queued' | 'failed' | 'cancelled'>;
  upsertTelegramUser(user: TelegramUser): Promise<TelegramUser>;
  setTelegramUserLocale(telegramUserId: string, locale: TelegramUser['locale']): Promise<void>;
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
