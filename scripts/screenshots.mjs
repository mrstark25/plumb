/**
 * Visual check across breakpoints, plus a console-error gate.
 *
 * Connects a read-only mock EIP-6963 wallet so the transaction card — the
 * surface that actually matters — can be captured with a real live quote. The
 * mock answers discovery, accounts and chainId; it never signs anything.
 *
 * Usage: npm run dev, then `npm run shots`. Images land in ./screenshots.
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const BASE_URL = process.env.SHOT_URL ?? 'http://localhost:3000';
const OUT = process.env.SHOT_DIR ?? './screenshots';
const ACCOUNT = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

const BREAKPOINTS = [
  { name: '320', width: 320, height: 800 },
  { name: '768', width: 768, height: 1024 },
  { name: '1024', width: 1024, height: 900 },
  { name: '1440', width: 1440, height: 900 },
];

const MOCK_WALLET = (account) => {
  const provider = {
    request: async ({ method }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
      if (method === 'eth_chainId') return '0x2105';
      return null;
    },
    on: () => {},
    removeListener: () => {},
  };
  const detail = Object.freeze({
    info: {
      uuid: 'mock', name: 'Test Wallet', rdns: 'test.wallet',
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
    },
    provider,
  });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
};

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const errors = [];

for (const bp of BREAKPOINTS) {
  const page = await browser.newPage({
    viewport: { width: bp.width, height: bp.height },
    deviceScaleFactor: 2,
  });
  page.on('pageerror', (e) => errors.push(`${bp.name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${bp.name}: ${m.text().slice(0, 200)}`);
  });

  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/empty-${bp.name}.png` });

  // The page must never scroll sideways at any width.
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  console.log(`${bp.name.padEnd(5)} captured${overflows ? '  ⚠ HORIZONTAL OVERFLOW' : ''}`);
  if (overflows) errors.push(`${bp.name}: horizontal overflow`);

  await page.close();
}

/*
 * The greeting animation: it must cycle through every capability, and it must
 * hold still and stay legible when the viewer has asked for reduced motion.
 */
const anim = await browser.newPage({ viewport: { width: 1400, height: 900 } });
anim.on('pageerror', (e) => errors.push(`anim: ${e.message}`));
await anim.goto(BASE_URL, { waitUntil: 'networkidle' });

const seen = new Set();
for (let i = 0; i < 6; i += 1) {
  await anim.waitForTimeout(2900);
  seen.add(await anim.$eval('.capability-phrase', (el) => el.textContent));
}
console.log(`anim  cycled ${seen.size} phrases`);
if (seen.size < 5) errors.push(`rotation stalled: only ${seen.size} distinct phrases`);

// Every element in the greeting block must share one left edge.
const edges = await anim.evaluate(() => {
  const x = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().left);
  return [x('.greeting-index'), x('.greeting-title'), x('.greeting-lede'), x('.composer')];
});
if (new Set(edges).size !== 1) errors.push(`greeting is not left-aligned: ${edges.join(', ')}`);
await anim.close();

const reduced = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
reduced.on('pageerror', (e) => errors.push(`reduced: ${e.message}`));
await reduced.goto(BASE_URL, { waitUntil: 'networkidle' });
await reduced.waitForTimeout(400);

const before = await reduced.$eval('.capability-phrase', (el) => el.textContent);
// Letters animate from opacity 0, so a skipped animation must leave them visible.
const opacity = await reduced.$eval('.capability-letter', (el) => getComputedStyle(el).opacity);
if (opacity !== '1') errors.push(`reduced motion hides the phrase (opacity ${opacity})`);
await reduced.waitForTimeout(6500);
if ((await reduced.$eval('.capability-phrase', (el) => el.textContent)) !== before) {
  errors.push('reduced motion still rotates the phrase');
}
console.log('anim  reduced-motion holds still and stays visible');
await reduced.close();

// The transaction card, with a live quote, at desktop width.
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => errors.push(`tx: ${e.message}`));
await page.addInitScript(MOCK_WALLET, ACCOUNT);
await page.goto(BASE_URL, { waitUntil: 'networkidle' });
await page.click('text=Connect wallet');
await page.click('text=Test Wallet');
await page.waitForSelector('.account-chip', { timeout: 15_000 });

await page.fill('textarea', 'swap 0.01 ETH to USDC on Base');
await page.keyboard.press('Enter');
await page.waitForSelector('.tx-card', { timeout: 150_000 });
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/swap-card.png`, fullPage: true });
console.log('tx    captured');

// The Morpho deposit ticket renders differently from a trade, so it gets its
// own capture rather than being assumed to look right.
const vaultPage = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
vaultPage.on('pageerror', (e) => errors.push(`vault: ${e.message}`));
await vaultPage.addInitScript(MOCK_WALLET, ACCOUNT);
await vaultPage.goto(BASE_URL, { waitUntil: 'networkidle' });
await vaultPage.click('text=Connect wallet');
await vaultPage.click('text=Test Wallet');
await vaultPage.waitForSelector('.account-chip', { timeout: 15_000 });
// Phrased so the router cannot reasonably choose a bridge instead: this
// capture is testing how the vault ticket looks, not how the agent decides.
await vaultPage.fill('textarea', 'Use the earn tool to build a Morpho vault deposit of 10 USDC on Base. Do not bridge.');
await vaultPage.keyboard.press('Enter');
await vaultPage.waitForSelector('.tx-vault', { timeout: 150_000 });
await vaultPage.waitForTimeout(900);
await vaultPage.screenshot({ path: `${OUT}/vault-deposit.png`, fullPage: true });
console.log('vault captured');

await browser.close();

if (errors.length > 0) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error('  -', e);
  process.exit(1);
}
console.log('\nNo console errors, no horizontal overflow.');
