import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { createCheckoutQr } from '../../src/bot.js';

type QrDecoder = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: string } | null;

// jsQR ships CommonJS runtime code but its declaration is not NodeNext-compatible.
const jsQR = createRequire(import.meta.url)('jsqr') as QrDecoder;

describe('checkout QR', () => {
  it('encodes the exact short-lived checkout URL into a decodable PNG', async () => {
    const checkoutUrl = 'https://new-api.example.test/api/integrations/telegram/v1/checkout/signed-token';
    const image = PNG.sync.read(await createCheckoutQr(checkoutUrl));
    const decoded = jsQR(
      new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.byteLength),
      image.width,
      image.height,
    );

    expect(decoded?.data).toBe(checkoutUrl);
  });
});
