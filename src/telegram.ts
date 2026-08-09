import { GrammyError, type Api } from 'grammy';

export async function sendMessageWithRetry(
  api: Api,
  chatId: string,
  text: string,
  maxRetries = 1,
): Promise<Awaited<ReturnType<Api['sendMessage']>>> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await api.sendMessage(chatId, text);
    } catch (error) {
      if (!(error instanceof GrammyError) || error.parameters.retry_after === undefined || attempt >= maxRetries) {
        throw error;
      }
      const waitMs = Math.min(error.parameters.retry_after * 1000, 60_000);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
