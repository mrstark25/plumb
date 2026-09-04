/**
 * Estimated liquidation price for a freshly opened isolated position.
 *
 * Hyperliquid's formula:
 *   liqPx = px − side · marginAvailable / size / (1 − l · side)
 * where side is +1 long / −1 short and l = 1 / maintenanceLeverage.
 * Maintenance leverage is twice the asset's maximum leverage, so the
 * maintenance margin fraction is 1 / (2 · maxLeverage).
 *
 * This is an estimate: it ignores fees, funding, and any cross-margin
 * interaction with other positions. The exchange's own figure appears on the
 * position once it is open, and that one is authoritative.
 */
export function estimateLiquidationPrice(input: {
  entryPrice: number;
  leverage: number;
  maxLeverage: number;
  isLong: boolean;
}): number | null {
  const { entryPrice, leverage, maxLeverage, isLong } = input;
  if (entryPrice <= 0 || leverage <= 0 || maxLeverage <= 0) return null;

  const side = isLong ? 1 : -1;
  const maintenanceLeverage = 2 * maxLeverage;
  const l = 1 / maintenanceLeverage;

  // Margin backing one unit of the position.
  const marginPerUnit = entryPrice / leverage;
  const denominator = 1 - l * side;
  if (denominator === 0) return null;

  const liquidation = entryPrice - (side * marginPerUnit) / denominator;
  return liquidation > 0 ? liquidation : null;
}

/** How far price must move against the position, as a percentage. */
export function liquidationDistancePct(entryPrice: number, liquidationPrice: number): number {
  if (entryPrice <= 0) return 0;
  return (Math.abs(entryPrice - liquidationPrice) / entryPrice) * 100;
}
