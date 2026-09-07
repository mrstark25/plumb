import { getAddress, isAddress, type Address } from 'viem';
import { resolveChain, type SupportedChainId } from './chains';

export interface TokenInfo {
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly chainId: SupportedChainId;
}

/**
 * Aggregators represent a chain's native asset with this sentinel address.
 * Both Uniswap's routing API and LI.FI accept it.
 */
export const NATIVE_ADDRESS: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export function isNative(address: string): boolean {
  return address.toLowerCase() === NATIVE_ADDRESS.toLowerCase();
}

/**
 * A deliberately small, hand-verified registry. Every address here was checked
 * against the chain's canonical token list. Anything outside it must be passed
 * as an explicit 0x address, which we then verify on-chain before quoting —
 * we never resolve an unknown symbol to an address by guessing.
 */
const REGISTRY: readonly TokenInfo[] = [
  // Ethereum
  { chainId: 1, symbol: 'ETH', name: 'Ether', decimals: 18, address: NATIVE_ADDRESS },
  { chainId: 1, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  { chainId: 1, symbol: 'USDC', name: 'USD Coin', decimals: 6, address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  { chainId: 1, symbol: 'USDT', name: 'Tether USD', decimals: 6, address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
  { chainId: 1, symbol: 'DAI', name: 'Dai Stablecoin', decimals: 18, address: '0x6B175474E89094C44Da98b954EedeAC495271d0F' },
  { chainId: 1, symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8, address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' },
  // Sky (formerly Maker). sUSDS on Ethereum is a real ERC-4626 over USDS;
  // symbol, decimals and `asset()` were all read from the chain.
  { chainId: 1, symbol: 'USDS', name: 'Sky USDS', decimals: 18, address: '0xdC035D45d973E3EC169d2276DDab16f1e407384F' },
  { chainId: 1, symbol: 'sUSDS', name: 'Sky Savings USDS', decimals: 18, address: '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD' },
  // Base
  { chainId: 8453, symbol: 'ETH', name: 'Ether', decimals: 18, address: NATIVE_ADDRESS },
  { chainId: 8453, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, address: '0x4200000000000000000000000000000000000006' },
  { chainId: 8453, symbol: 'USDC', name: 'USD Coin', decimals: 6, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  { chainId: 8453, symbol: 'DAI', name: 'Dai Stablecoin', decimals: 18, address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb' },
  { chainId: 8453, symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', decimals: 8, address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' },
  // The Base sUSDS is a bridged representation: it answers symbol() and
  // decimals() and nothing else — no asset(), no convertToAssets(). It is a
  // token holding here, never a savings position.
  { chainId: 8453, symbol: 'USDS', name: 'Sky USDS', decimals: 18, address: '0x820C137fa70C8691f0e44Dc420a5e53c168921Dc' },
  { chainId: 8453, symbol: 'sUSDS', name: 'Sky Savings USDS', decimals: 18, address: '0x5875eEE11Cf8398102FdAd704C9E96607675467a' },
  // Arbitrum
  { chainId: 42161, symbol: 'ETH', name: 'Ether', decimals: 18, address: NATIVE_ADDRESS },
  { chainId: 42161, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
  { chainId: 42161, symbol: 'USDC', name: 'USD Coin', decimals: 6, address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
  { chainId: 42161, symbol: 'USDT', name: 'Tether USD', decimals: 6, address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' },
  { chainId: 42161, symbol: 'DAI', name: 'Dai Stablecoin', decimals: 18, address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1' },
  { chainId: 42161, symbol: 'ARB', name: 'Arbitrum', decimals: 18, address: '0x912CE59144191C1204E64559FE8253a0e49E6548' },
  { chainId: 42161, symbol: 'WBTC', name: 'Wrapped BTC', decimals: 8, address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f' },
  // Polygon
  { chainId: 137, symbol: 'POL', name: 'Polygon Ecosystem Token', decimals: 18, address: NATIVE_ADDRESS },
  { chainId: 137, symbol: 'WPOL', name: 'Wrapped POL', decimals: 18, address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270' },
  { chainId: 137, symbol: 'USDC', name: 'USD Coin', decimals: 6, address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
  { chainId: 137, symbol: 'USDC.e', name: 'USD Coin (bridged)', decimals: 6, address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' },
  // Polymarket settles in pUSD, a 1:1 USDC wrapper — not USDC.e directly.
  // Trading it means wrapping USDC.e through Polymarket's on-ramp first.
  { chainId: 137, symbol: 'pUSD', name: 'Polymarket USD', decimals: 6, address: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB' },
  { chainId: 137, symbol: 'USDT', name: 'Tether USD', decimals: 6, address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' },
  { chainId: 137, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619' },
  /*
   * Robinhood Chain. Deliberately short: there is no canonical USDC, USDT or
   * DAI on this chain yet, and the bridged token list already carries two
   * different contracts both calling themselves USDG — exactly the collision
   * this registry exists to keep out. Every address below had its symbol and
   * decimals read from chain 4663 before being written down.
   */
  { chainId: 4663, symbol: 'ETH', name: 'Ether', decimals: 18, address: NATIVE_ADDRESS },
  { chainId: 4663, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' },
  { chainId: 4663, symbol: 'LINK', name: 'ChainLink Token', decimals: 18, address: '0x492641F648a4986844848E0beFE66D14817bCE34' },
  { chainId: 4663, symbol: 'USDe', name: 'Ethena USDe', decimals: 18, address: '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34' },
] as const;

export function knownTokens(chainId: SupportedChainId): TokenInfo[] {
  return REGISTRY.filter((t) => t.chainId === chainId);
}

/**
 * Every symbol the registry can resolve, for the system prompt.
 *
 * Deliberately flat rather than broken down per chain: the per-chain listing
 * cost more tokens on every request than it earned, and asking for a token
 * that is not on a given chain already fails with a clear message.
 */
export function tokenCatalogue(): string {
  const symbols = new Set(REGISTRY.map((t) => t.symbol));
  return [...symbols].join(', ');
}

export function findToken(chain: string | number, symbolOrAddress: string): TokenInfo | undefined {
  const chainId = resolveChain(chain);
  const query = symbolOrAddress.trim();

  if (isAddress(query)) {
    const checksummed = getAddress(query);
    return REGISTRY.find((t) => t.chainId === chainId && getAddress(t.address) === checksummed);
  }
  const lower = query.toLowerCase();
  return REGISTRY.find((t) => t.chainId === chainId && t.symbol.toLowerCase() === lower);
}
