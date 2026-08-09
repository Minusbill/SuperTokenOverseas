import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import { NewApiClient, NewApiError } from '../../src/new-api.js';

const logger = pino({ enabled: false });
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.close();
    await once(server, 'close');
  }));
});

type RequestHandler = (request: IncomingMessage, response: ServerResponse<IncomingMessage>) => void;

async function startServer(handler: RequestHandler): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

function config(baseUrl: string, mode: 'admin' | 'bridge' = 'bridge'): Config {
  return loadConfig({
    NODE_ENV: 'test',
    BOT_MODE: 'polling',
    TELEGRAM_BOT_TOKEN: 'test-token',
    NEW_API_BASE_URL: baseUrl,
    NEW_API_INTEGRATION_MODE: mode,
    NEW_API_ADMIN_PAT: mode === 'admin' ? 'admin-pat' : undefined,
    NEW_API_INTEGRATION_SECRET: mode === 'bridge' ? 'integration-secret-123456' : undefined,
  });
}

describe('NewApiClient', () => {
  it('unwraps a successful bridge account response and signs the request', async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    let receivedBody = '';
    const baseUrl = await startServer((request, response) => {
      receivedHeaders = request.headers;
      request.setEncoding('utf8');
      request.on('data', (chunk: Buffer | string) => { receivedBody += chunk.toString(); });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          success: true,
          data: {
            id: 42,
            username: 'alice',
            telegram_id: '1001',
            status: 1,
            quota: 500000,
            used_quota: 1000,
          },
        }));
      });
    });

    const account = await new NewApiClient(config(baseUrl), logger).resolveAccountByTelegramId('1001');
    expect(account).toMatchObject({ id: 42, username: 'alice', telegramId: '1001' });
    expect(receivedBody).toBe('{"telegram_id":"1001"}');
    expect(receivedHeaders['x-integration-signature']).toEqual(expect.any(String));
    expect(receivedHeaders['x-integration-nonce']).toEqual(expect.any(String));
    expect(receivedHeaders['x-integration-timestamp']).toEqual(expect.any(String));
  });

  it('turns HTTP 200 success:false into an API error', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ success: false, message: 'telegram account is not bound' }));
    });

    await expect(new NewApiClient(config(baseUrl), logger).resolveAccountByTelegramId('1001'))
      .rejects.toMatchObject({ code: 'api' } satisfies Partial<NewApiError>);
  });

  it('rejects an unknown quota display type instead of guessing the currency', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        success: true,
        data: { quota_per_unit: 500000, quota_display_type: 'EUR' },
      }));
    });

    await expect(new NewApiClient(config(baseUrl), logger).getStatus())
      .rejects.toMatchObject({ code: 'contract' } satisfies Partial<NewApiError>);
  });

  it('accepts the SubscriptionSummary wrapper returned by new-api', async () => {
    const baseUrl = await startServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        success: true,
        data: [{
          subscription: {
            id: 9,
            plan_id: 3,
            status: 'active',
            start_time: 1,
            end_time: 2,
            amount_total: 100,
            amount_used: 20,
          },
        }],
      }));
    });

    const subscriptions = await new NewApiClient(config(baseUrl), logger).getSubscriptions({
      id: 42,
      username: 'alice',
      telegramId: '1001',
      status: 1,
      quota: 0,
      usedQuota: 0,
    });
    expect(subscriptions[0]).toMatchObject({ id: 9, planId: 3, amount: 100, usedAmount: 20, remainingAmount: 80 });
  });
});
