import { formatUnits, parseUnits } from 'viem';

const USD_LARGE = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});
const USD_SMALL = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 2,
});

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Math.abs(value) >= 1000 ? USD_LARGE.format(value) : USD_SMALL.format(value);
}

export function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const units: readonly [number, string][] = [
    [1e9, 'B'], [1e6, 'M'], [1e3, 'K'],
  ];
  for (const [threshold, suffix] of units) {
    if (Math.abs(value) >= threshold) return `$${(value / threshold).toFixed(1)}${suffix}`;
  }
  return USD_SMALL.format(value);
}

/**
 * Fees specifically: a true zero is almost always "we could not price it", and
 * rendering that as "$0.00" tells the user the transaction is free.
 */
export function formatFeeUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 'Not available';
  return value < 0.01 ? '<$0.01' : formatUsd(value);
}

export function formatPercent(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/**
 * Token amounts are shown with precision that scales to magnitude: six figures
 * of significance for dust, two for large balances. Never rounds up to a value
 * the user does not hold.
 */
export function formatTokenAmount(raw: bigint, decimals: number): string {
  const exact = Number(formatUnits(raw, decimals));
  if (exact === 0) return '0';
  if (exact < 0.000001) return '<0.000001';
  const fractionDigits = exact < 1 ? 6 : exact < 1000 ? 4 : 2;
  return exact.toLocaleString('en-US', { maximumFractionDigits: fractionDigits });
}

/**
 * Parses a human amount ("1.5", "0.0001") into base units. Rejects anything
 * that is not a plain positive decimal so that model-produced strings such as
 * "1e18", "all", or "1,000" can never silently become the wrong number.
 */
export function parseAmount(input: string, decimals: number): bigint {
  const value = input.trim();
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Invalid amount "${input}". Use a plain decimal number, e.g. 1.5`);
  }
  const [, fraction = ''] = value.split('.');
  if (fraction.length > decimals) {
    throw new Error(`Amount "${input}" has more precision than the token's ${decimals} decimals.`);
  }
  const parsed = parseUnits(value, decimals);
  if (parsed <= 0n) throw new Error('Amount must be greater than zero.');
  return parsed;
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}
