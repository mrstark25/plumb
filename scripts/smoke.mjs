/**
 * Live smoke test for the three upstreams Plumb depends on.
 *
 * Asserts that the exact request shapes the providers build still return the
 * exact fields they read. Run it when a swap or bridge starts failing for no
 * apparent reason: `node scripts/smoke.mjs`.
 */
const WALLET = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'; // vitalik.eth, read-only

let failures = 0;

function check(label, condition, detail = '') {
  const mark = condition ? '  ok ' : ' FAIL';
  if (!condition) failures += 1;
  console.log(`${mark}  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function testDefiLlama() {
  console.log('\nDefiLlama yields');
  const res = await fetch('https://yields.llama.fi/pools');
  check('GET /pools responds 200', res.status === 200, `status ${res.status}`);
  const body = await res.json();
  const pools = body.data ?? [];
  check('returns a pool array', Array.isArray(pools) && pools.length > 1000, `${pools.length} pools`);

  const sample = pools.find((p) => p.tvlUsd > 1e7 && p.apy > 0);
  const required = ['chain', 'project', 'symbol', 'tvlUsd', 'apy', 'apyMean30d', 'pool',
                    'stablecoin', 'ilRisk', 'exposure', 'outlier', 'sigma', 'predictions'];
  const missing = required.filter((k) => !(k in sample));
  check('every field the provider reads is present', missing.length === 0, missing.join(', '));
  check('apy is a percentage, not a fraction', sample.apy > 0.01, `${sample.apy}`);
  check('predictions is an object', typeof sample.predictions === 'object');
}

async function testLifi() {
  console.log('\nLI.FI bridge (Arbitrum USDC -> Base USDC)');
  const params = new URLSearchParams({
    fromChain: '42161', toChain: '8453',
    fromToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    toToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    fromAmount: '1000000', fromAddress: WALLET, toAddress: WALLET,
    slippage: '0.005', integrator: 'liberty-ai', order: 'CHEAPEST',
  });
  const res = await fetch(`https://li.quest/v1/quote?${params}`);
  check('GET /quote responds 200 without an API key', res.status === 200, `status ${res.status}`);
  if (res.status !== 200) return console.log(`       ${(await res.text()).slice(0, 200)}`);

  const q = await res.json();
  check('estimate.approvalAddress present', typeof q.estimate?.approvalAddress === 'string');
  check('estimate.toAmountMin present', typeof q.estimate?.toAmountMin === 'string');
  check('estimate.executionDuration is a number', typeof q.estimate?.executionDuration === 'number');
  check('transactionRequest present', Boolean(q.transactionRequest));
  check('toolDetails.name present', typeof q.toolDetails?.name === 'string', q.toolDetails?.name);

  const tx = q.transactionRequest ?? {};
  check('transactionRequest.value is 0x-hex (needs conversion)',
        typeof tx.value === 'string' && tx.value.startsWith('0x'), String(tx.value));
  check('estimate.toAmount is decimal (no conversion)',
        /^\d+$/.test(String(q.estimate?.toAmount)), String(q.estimate?.toAmount));
  check('chainId is a number', typeof tx.chainId === 'number');
}

async function testOpenOcean() {
  console.log('\nOpenOcean swap fallback (Base: 0.01 ETH -> USDC)');
  const params = new URLSearchParams({
    inTokenAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    outTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '0.01', gasPrice: '0.01', slippage: '0.5', account: WALLET,
  });
  const url = `https://open-api.openocean.finance/v4/base/swap?${params}`;

  const bare = await fetch(url);
  check('bare request is blocked (Referer really is required)', bare.status !== 200, `status ${bare.status}`);

  const res = await fetch(url, {
    headers: { referer: 'https://openocean.finance/', origin: 'https://openocean.finance' },
  });
  check('request with Referer responds 200', res.status === 200, `status ${res.status}`);
  if (res.status !== 200) return;

  const body = await res.json();
  check('code is 200', body.code === 200, String(body.code));
  const d = body.data ?? {};
  for (const key of ['to', 'data', 'value', 'outAmount', 'minOutAmount', 'estimatedGas']) {
    check(`data.${key} present`, d[key] !== undefined, String(d[key]).slice(0, 20));
  }
  check('outAmount is wei, not human-readable', String(d.outAmount).length > 6, String(d.outAmount));
}

async function testUniswap() {
  console.log('\nUniswap Trading API');
  if (!process.env.UNISWAP_API_KEY) {
    console.log('  skip  UNISWAP_API_KEY not set — the OpenOcean fallback covers swaps.');
    return;
  }
  const res = await fetch('https://trade-api.gateway.uniswap.org/v1/quote', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.UNISWAP_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
      'x-permit2-disabled': 'true',
    },
    body: JSON.stringify({
      type: 'EXACT_INPUT', amount: '10000000000000000',
      tokenInChainId: 8453, tokenOutChainId: 8453,
      tokenIn: '0x0000000000000000000000000000000000000000',
      tokenOut: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      swapper: WALLET, slippageTolerance: 0.5,
      routingPreference: 'BEST_PRICE', urgency: 'normal',
    }),
  });
  check('POST /quote responds 200', res.status === 200, `status ${res.status}`);
  if (res.status !== 200) return console.log(`       ${(await res.text()).slice(0, 250)}`);
  const q = await res.json();
  check('routing is CLASSIC/WRAP/UNWRAP', ['CLASSIC', 'WRAP', 'UNWRAP'].includes(q.routing), q.routing);
  check('permitData is null with x-permit2-disabled', q.permitData === null, String(q.permitData));
  check('quote.output.minimumAmount present', typeof q.quote?.output?.minimumAmount === 'string');
}

async function testUniswapBridge() {
  console.log('\nUniswap cross-chain (Arbitrum USDC -> Base USDC)');
  if (!process.env.UNISWAP_API_KEY) {
    console.log('  skip  UNISWAP_API_KEY not set — bridging falls back to LI.FI.');
    return;
  }
  const headers = {
    'x-api-key': process.env.UNISWAP_API_KEY,
    'content-type': 'application/json',
    accept: 'application/json',
    'x-permit2-disabled': 'true',
  };
  const res = await fetch('https://trade-api.gateway.uniswap.org/v1/quote', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'EXACT_INPUT', amount: '1000000',
      tokenInChainId: 42161, tokenOutChainId: 8453,
      tokenIn: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      tokenOut: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      swapper: WALLET, slippageTolerance: 0.5, urgency: 'normal',
    }),
  });
  check('POST /quote responds 200 for a cross-chain pair', res.status === 200, `status ${res.status}`);
  if (res.status !== 200) return console.log(`       ${(await res.text()).slice(0, 200)}`);

  const q = await res.json();
  check('routing is BRIDGE', q.routing === 'BRIDGE', q.routing);
  check('estimatedFillTimeMs present', typeof q.quote?.estimatedFillTimeMs === 'number', String(q.quote?.estimatedFillTimeMs));
  check('output.minimumAmount present', typeof q.quote?.output?.minimumAmount === 'string');

  const swapRes = await fetch('https://trade-api.gateway.uniswap.org/v1/swap', {
    method: 'POST', headers,
    body: JSON.stringify({ quote: q.quote, simulateTransaction: false }),
  });
  check('POST /swap builds bridge calldata', swapRes.status === 200, `status ${swapRes.status}`);
  if (swapRes.status !== 200) return;

  const { swap } = await swapRes.json();
  check('tx targets the SOURCE chain', swap?.chainId === 42161, String(swap?.chainId));
  check('tx.value is 0x-hex here (needs normalising)',
        typeof swap?.value === 'string' && swap.value.startsWith('0x'), String(swap?.value));
  check('tx.data present', typeof swap?.data === 'string' && swap.data.startsWith('0x'));
}

async function testMorpho() {
  console.log('\nMorpho vaults (GraphQL, no key)');
  const query = (root, extra) => `query($c:[Int!],$m:Float,$f:Int!){ ${root}(first:$f, orderBy:NetApy, orderDirection:Desc, where:{chainId_in:$c, listed:true, totalAssetsUsd_gte:$m}){ items { address name chain{id} asset{address symbol decimals} ${extra} } } }`;

  const ask = async (q) => {
    const res = await fetch('https://api.morpho.org/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: q, variables: { c: [1, 8453, 42161], m: 1000000, f: 3 } }),
    });
    return { status: res.status, body: await res.json() };
  };

  // V1 and V2 are separate roots with different shapes; both must keep working.
  const v1 = await ask(query('vaults', 'warnings{level} state{ netApy totalAssetsUsd curators{name} }'));
  check('V1 /vaults responds 200 without a key', v1.status === 200, `status ${v1.status}`);
  check('V1 returned no GraphQL errors', !v1.body.errors, JSON.stringify(v1.body.errors ?? '').slice(0, 120));

  const a = v1.body?.data?.vaults?.items?.[0];
  check('V1 netApy is nested under state', typeof a?.state?.netApy === 'number', String(a?.state?.netApy));
  check('V1 netApy is a fraction, not a percent', a?.state?.netApy < 1, String(a?.state?.netApy));
  check('V1 curators live on state', Array.isArray(a?.state?.curators), typeof a?.state?.curators);

  const v2 = await ask(query('vaultV2s', 'netApy totalAssetsUsd curators{ items{name} }'));
  check('V2 /vaultV2s responds 200', v2.status === 200, `status ${v2.status}`);
  check('V2 returned no GraphQL errors', !v2.body.errors, JSON.stringify(v2.body.errors ?? '').slice(0, 120));

  const b = v2.body?.data?.vaultV2s?.items?.[0];
  check('V2 netApy is flat on the vault', typeof b?.netApy === 'number', String(b?.netApy));
  check('V2 curators are paginated under items', Array.isArray(b?.curators?.items), typeof b?.curators);

  /*
   * The trap worth regression-guarding: Vaults V2 stub out maxDeposit() and
   * always return 0, so any capacity check based on it silently rejects every
   * V2 deposit. Pinned to two known Base vaults so this always runs.
   */
  const V1_BASE = '0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61'; // Gauntlet USDC Prime
  const V2_BASE = '0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9'; // Steakhouse Prime USDC

  /*
   * Retries, and throws rather than returning null on failure. A helper that
   * collapses "the RPC was rate-limited" into the same value as "the contract
   * returned 0" turns a flaky network into a false assertion about on-chain
   * behaviour — which is exactly what it did the first time.
   */
  const call = async (to, data, attempt = 0) => {
    try {
      const res = await fetch('https://mainnet.base.org', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
      });
      const j = await res.json();
      if (typeof j.result === 'string') return BigInt(j.result);
      throw new Error(j.error?.message ?? `no result (HTTP ${res.status})`);
    } catch (cause) {
      if (attempt >= 4) throw new Error(`eth_call to ${to} failed: ${cause.message}`);
      // A shared public RPC needs seconds to clear, not milliseconds.
      await new Promise((r) => setTimeout(r, 1200 * 2 ** attempt));
      return call(to, data, attempt + 1);
    }
  };
  const PREVIEW_1_USDC = '0xef8b30f700000000000000000000000000000000000000000000000000000000000f4240';
  const MAX_DEPOSIT = '0x402d267d000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045';
  const DECIMALS = '0x313ce567';

  // Spaced out deliberately: the public Base RPC rate-limits a tight loop.
  const pause = () => new Promise((r) => setTimeout(r, 400));

  for (const [label, vault] of [['V1', V1_BASE], ['V2', V2_BASE]]) {
    const preview = await call(vault, PREVIEW_1_USDC);
    check(`${label} previewDeposit returns non-zero shares`, preview !== null && preview > 0n, String(preview));
    await pause();
    const decimals = await call(vault, DECIMALS);
    check(`${label} share decimals are 18, not the asset's 6`, decimals === 18n, String(decimals));
    await pause();
  }

  const v1Max = await call(V1_BASE, MAX_DEPOSIT);
  await pause();
  const v2Max = await call(V2_BASE, MAX_DEPOSIT);
  check('V1 maxDeposit reports a real cap', v1Max !== null && v1Max > 0n, String(v1Max));
  check('V2 maxDeposit is stubbed to 0 (never gate capacity on it)', v2Max === 0n, String(v2Max));

}

async function testCoinGecko() {
  console.log('\nCoinGecko prices (free tier)');

  // The fallback matters more than the primary: it is what keeps prices
  // working when CoinGecko rate-limits.
  const llama = await fetch('https://coins.llama.fi/prices/current/coingecko:bitcoin,coingecko:ethereum');
  check('DefiLlama fallback prices by coingecko id', llama.status === 200, `status ${llama.status}`);
  if (llama.status === 200) {
    const body = await llama.json();
    check('fallback returns a bitcoin price',
          typeof body.coins?.['coingecko:bitcoin']?.price === 'number',
          String(body.coins?.['coingecko:bitcoin']?.price));
  }

  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_last_updated_at=true',
  );
  if (res.status === 429) {
    // The keyless tier is a few calls per minute. That is a known limit, not a
    // broken contract, and the app falls back to DefiLlama when it happens.
    console.log('  skip  rate-limited (429) — set COINGECKO_API_KEY to raise the limit.');
    return;
  }
  check('GET /simple/price responds 200 without a key', res.status === 200, `status ${res.status}`);
  if (res.status !== 200) return console.log(`       ${(await res.text()).slice(0, 160)}`);

  const body = await res.json();
  check('bitcoin priced', typeof body.bitcoin?.usd === 'number', String(body.bitcoin?.usd));
  check('ethereum priced', typeof body.ethereum?.usd === 'number', String(body.ethereum?.usd));
  check('24h change present', typeof body.bitcoin?.usd_24h_change === 'number');
  check('market cap present', typeof body.bitcoin?.usd_market_cap === 'number');
  check('last_updated_at is seconds, not ms',
        String(body.bitcoin?.last_updated_at ?? '').length === 10, String(body.bitcoin?.last_updated_at));

  // Contract lookups back the USD figures on swap and deposit cards.
  const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const tokenRes = await fetch(
    `https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${USDC_BASE}&vs_currencies=usd`,
  );
  if (tokenRes.status === 429) return console.log('  skip  token_price rate-limited (429).');
  check('GET /simple/token_price responds 200', tokenRes.status === 200, `status ${tokenRes.status}`);
  if (tokenRes.status !== 200) return;

  const tokenBody = await tokenRes.json();
  // The response keys are lower-cased, which is easy to miss.
  check('response key is the LOWERCASED address',
        tokenBody[USDC_BASE.toLowerCase()] !== undefined && tokenBody[USDC_BASE] === undefined,
        Object.keys(tokenBody).join(','));
  check('USDC prices near $1',
        Math.abs((tokenBody[USDC_BASE.toLowerCase()]?.usd ?? 0) - 1) < 0.05,
        String(tokenBody[USDC_BASE.toLowerCase()]?.usd));
}

for (const test of [testDefiLlama, testLifi, testOpenOcean, testUniswap, testUniswapBridge, testMorpho, testCoinGecko]) {
  try {
    await test();
  } catch (cause) {
    failures += 1;
    console.log(`  FAIL  ${test.name} threw — ${cause.message}`);
  }
}

console.log(failures === 0 ? '\nAll upstream contracts hold.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
