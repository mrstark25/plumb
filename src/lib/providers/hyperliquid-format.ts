/**
 * Hyperliquid rejects orders whose price or size violate its tick and lot
 * rules, so both are normalised before an order is ever built.
 *
 * Prices: at most 5 significant figures, and at most (MAX_DECIMALS - szDecimals)
 * decimal places, where MAX_DECIMALS is 6 for perps. Integer prices are always
 * allowed regardless of significant figures — 100000 is valid even though it
 * has six.
 *
 * Sizes: exactly szDecimals decimal places.
 */
const PERP_MAX_DECIMALS = 6;
const MAX_SIGNIFICANT_FIGURES = 5;

export function roundPerpPrice(price: number, szDecimals: number): number {
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid price: ${price}`);
  }

  // An integer price is always acceptable and needs no significant-figure cut.
  if (Number.isInteger(price)) return price;

  const maxDecimals = Math.max(0, PERP_MAX_DECIMALS - szDecimals);
  const significant = Number(price.toPrecision(MAX_SIGNIFICANT_FIGURES));

  // Apply whichever constraint bites harder.
  return Number(significant.toFixed(maxDecimals));
}

export function roundPerpSize(size: number, szDecimals: number): number {
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`Invalid size: ${size}`);
  }
  // Rounded down so a computed size can never exceed the margin it was sized
  // against.
  const factor = 10 ** szDecimals;
  return Math.floor(size * factor) / factor;
}

/**
 * The wire format wants numbers as strings with no exponent and no trailing
 * zeros — "0.0001", never "1e-4" and never "0.00010".
 */
export function toWireNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`Not a finite number: ${value}`);
  if (Number.isInteger(value)) return String(value);

  // toFixed(8) avoids exponent notation for the magnitudes traded here.
  return value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * A market order is a limit order priced far enough through the book to fill
 * immediately, combined with immediate-or-cancel. The slippage bound is what
 * stops "far enough" becoming "at any price".
 */
export function marketablePrice(input: {
  midPrice: number;
  isBuy: boolean;
  slippageBps: number;
  szDecimals: number;
}): number {
  const drift = input.slippageBps / 10_000;
  const raw = input.isBuy ? input.midPrice * (1 + drift) : input.midPrice * (1 - drift);
  return roundPerpPrice(raw, input.szDecimals);
}
