import { getAddress, isAddress, type Address } from 'viem';
import { resolveChain, type SupportedChainId } from '@/lib/chains';
import { findToken, NATIVE_ADDRESS, type TokenInfo } from '@/lib/tokens';
import { readTokenMetadata } from '@/lib/erc20';
import { sanitiseSymbol } from '@/lib/sanitise';

/**
 * Turns whatever the model produced into a concrete token.
 *
 * A known symbol resolves from the vetted registry. A raw address is accepted
 * but its metadata is read from the chain rather than trusted from the model.
 * An unknown symbol is refused outright — guessing an address for a ticker is
 * how users end up swapping into an impostor token.
 */
export async function resolveToken(
  chain: string | number,
  symbolOrAddress: string,
): Promise<TokenInfo> {
  const chainId = resolveChain(chain);
  const query = symbolOrAddress.trim();

  const known = findToken(chainId, query);
  if (known) return known;

  if (isAddress(query)) return resolveByAddress(chainId, getAddress(query));

  throw new Error(
    `I don't recognise "${symbolOrAddress}" on that chain. Give me its contract address and I'll verify it on-chain before quoting.`,
  );
}

async function resolveByAddress(chainId: SupportedChainId, address: Address): Promise<TokenInfo> {
  if (address.toLowerCase() === NATIVE_ADDRESS.toLowerCase()) {
    return findToken(chainId, 'ETH')!;
  }
  try {
    const { symbol, decimals } = await readTokenMetadata(chainId, address);
    const safeSymbol = sanitiseSymbol(symbol);
    return { address, symbol: safeSymbol, name: safeSymbol, decimals, chainId };
  } catch {
    throw new Error(
      `${address} does not look like a readable ERC-20 on that chain — I could not read its symbol and decimals, so I won't quote against it.`,
    );
  }
}
