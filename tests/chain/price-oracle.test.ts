import { describe, expect, it, vi } from 'vitest';

import { PriceOracle } from '../../server/chain/price-oracle.js';

const MINT = 'AstroidMint1111111111111111111111111111111';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('PriceOracle', () => {
  it('parses usdPrice from a Jupiter v3 response and reports it', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ [MINT]: { usdPrice: 0.0042, decimals: 6 } }),
    ) as unknown as typeof fetch;

    const prices: number[] = [];
    const oracle = new PriceOracle({
      mint: MINT,
      refreshMs: 0,
      fetchImpl,
      onPrice: (p) => prices.push(p),
    });

    const p = await oracle.refreshOnce();
    expect(p).toBe(0.0042);
    expect(oracle.getPrice()).toBe(0.0042);
    expect(prices).toEqual([0.0042]);
    // The mint must be passed as the `ids` query param.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain(MINT);
  });

  it('sends the API key header when configured', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ [MINT]: { usdPrice: 1 } }),
    ) as unknown as typeof fetch;
    const oracle = new PriceOracle({ mint: MINT, refreshMs: 0, apiKey: 'secret-key', fetchImpl });
    await oracle.refreshOnce();
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(init.headers).toEqual({ 'x-api-key': 'secret-key' });
  });

  it('keeps the last good price when a refresh fails (HTTP error)', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1 ? jsonResponse({ [MINT]: { usdPrice: 0.01 } }) : jsonResponse({}, false, 503);
    }) as unknown as typeof fetch;

    const oracle = new PriceOracle({ mint: MINT, refreshMs: 0, fetchImpl });
    expect(await oracle.refreshOnce()).toBe(0.01);
    expect(await oracle.refreshOnce()).toBeNull();
    expect(oracle.getPrice()).toBe(0.01); // unchanged
  });

  it('ignores non-positive / missing prices', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ [MINT]: { usdPrice: 0 } }),
    ) as unknown as typeof fetch;
    const oracle = new PriceOracle({ mint: MINT, refreshMs: 0, fetchImpl });
    expect(await oracle.refreshOnce()).toBeNull();
    expect(oracle.getPrice()).toBe(0);
  });

  it('tracks a second (SOL) mint in the same request when solMint is set', async () => {
    const SOL = 'So11111111111111111111111111111111111111112';
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ [MINT]: { usdPrice: 0.00005 }, [SOL]: { usdPrice: 68.23 } }),
    ) as unknown as typeof fetch;
    const oracle = new PriceOracle({ mint: MINT, solMint: SOL, refreshMs: 0, fetchImpl });
    await oracle.refreshOnce();
    expect(oracle.getPrice()).toBe(0.00005);
    expect(oracle.getSolPrice()).toBe(68.23);
    // Both ids ride in a single request.
    const url = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(url).toContain(MINT);
    expect(url).toContain(SOL);
  });

  it('getSolPrice stays 0 when solMint is not configured', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ [MINT]: { usdPrice: 0.1 } }),
    ) as unknown as typeof fetch;
    const oracle = new PriceOracle({ mint: MINT, refreshMs: 0, fetchImpl });
    await oracle.refreshOnce();
    expect(oracle.getSolPrice()).toBe(0);
  });

  it('keeps the last good SOL price when a later quote omits it (best-effort)', async () => {
    const SOL = 'So11111111111111111111111111111111111111112';
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1
        ? jsonResponse({ [MINT]: { usdPrice: 0.00005 }, [SOL]: { usdPrice: 68 } })
        : jsonResponse({ [MINT]: { usdPrice: 0.00006 } }); // SOL missing this round
    }) as unknown as typeof fetch;
    const oracle = new PriceOracle({ mint: MINT, solMint: SOL, refreshMs: 0, fetchImpl });
    await oracle.refreshOnce();
    await oracle.refreshOnce();
    expect(oracle.getPrice()).toBe(0.00006); // updated
    expect(oracle.getSolPrice()).toBe(68); // retained
  });
});
