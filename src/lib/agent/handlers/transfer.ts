import { encodeFunctionData, erc20Abi, getAddress, isAddress, type Address } from 'viem';
import { chainName, resolveChain, type SupportedChainId } from '@/lib/chains';
import { formatTokenAmount, parseAmount } from '@/lib/format';
import { readBalance } from '@/lib/erc20';
import { isNative } from '@/lib/tokens';
import { publicClientFor } from '@/lib/viem';
import { getUsdPrice } from '@/lib/providers/prices';
import type { TxProposal, TxStep } from '@/types/tx';
import { resolveToken } from '../resolve';
import { TRANSFER_TTL_MS } from './shared';

export interface TransferArgs {
  chain: string;
  token: string;
  amount: string;
  recipient: string;
}

/**
 * Native sends must leave enough behind to pay for themselves. Reserving a
 * flat headroom is cruder than estimating gas, but it fails safe: the worst
 * outcome is telling someone to send slightly less, rather than producing a
 * transaction that cannot be mined.
 */
const NATIVE_GAS_RESERVE_WEI = 200_000_000_000_000n; // 0.0002 ETH

export async function buildTransferProposal(
  args: TransferArgs,
  wallet: Address,
): Promise<TxProposal> {
  const chainId = resolveChain(args.chain);
  const recipient = await resolveRecipient(args.recipient, chainId);
  const token = await resolveToken(chainId, args.token);

  if (recipient.toLowerCase() === wallet.toLowerCase()) {
    throw new Error('That address is your own wallet — the transfer would do nothing but cost gas.');
  }
  if (recipient.toLowerCase() === token.address.toLowerCase()) {
    // Tokens sent to their own contract are almost always unrecoverable.
    throw new Error(
      `That address is the ${token.symbol} contract itself. Tokens sent there are almost always lost forever, so I will not build it.`,
    );
  }

  const amount = parseAmount(args.amount, token.decimals);
  const balance = await readBalance({ chainId, token: token.address, owner: wallet });

  if (balance < amount) {
    throw new Error(
      `Your ${token.symbol} balance on ${chainName(chainId)} is ${formatTokenAmount(balance, token.decimals)}, less than the ${args.amount} you asked to send.`,
    );
  }

  const sendsNative = isNative(token.address);
  if (sendsNative && balance - amount < NATIVE_GAS_RESERVE_WEI) {
    throw new Error(
      `That would leave too little ${token.symbol} to pay for gas. Send at most ${formatTokenAmount(
        balance > NATIVE_GAS_RESERVE_WEI ? balance - NATIVE_GAS_RESERVE_WEI : 0n,
        token.decimals,
      )} ${token.symbol} and keep the rest for the fee.`,
    );
  }

  const [price, recipientIsContract] = await Promise.all([
    getUsdPrice(chainId, token.address),
    isContract(chainId, recipient),
  ]);

  const amountUsd = price ? (Number(amount) / 10 ** token.decimals) * price : undefined;

  const step: TxStep = sendsNative
    ? {
        id: 'transfer-native',
        kind: 'transfer',
        label: `Send ${args.amount} ${token.symbol}`,
        detail: `A direct transfer to ${recipient}.`,
        execute: {
          via: 'transaction',
          tx: { chainId, to: recipient, data: '0x', value: amount.toString() },
        },
      }
    : {
        id: 'transfer-erc20',
        kind: 'transfer',
        label: `Send ${args.amount} ${token.symbol}`,
        detail: `Calls transfer on the ${token.symbol} contract. No approval needed.`,
        execute: {
          via: 'transaction',
          tx: {
            chainId,
            to: token.address,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'transfer',
              args: [recipient, amount],
            }),
            value: '0',
          },
        },
      };

  const asset = {
    symbol: token.symbol,
    address: token.address,
    chainId,
    decimals: token.decimals,
    amount: amount.toString(),
    ...(amountUsd !== undefined ? { amountUsd } : {}),
  };

  return {
    id: crypto.randomUUID(),
    kind: 'transfer',
    from: asset,
    // A transfer does not convert anything; both legs are the same asset.
    to: asset,
    recipient,
    // Sending to someone else is the entire point here, so this is not framed
    // as a warning the way a redirected bridge is.
    isSelfCustody: false,
    minReceived: amount.toString(),
    slippageBps: 0,
    route: `Direct transfer on ${chainName(chainId)}`,
    provider: 'Wallet',
    steps: [step],
    warnings: transferWarnings({
      symbol: token.symbol,
      recipientIsContract,
      sendsNative,
      chainId,
    }),
    expiresAt: Date.now() + TRANSFER_TTL_MS,
  };
}

/**
 * Accepts a raw address or an ENS name.
 *
 * ENS is resolved on Ethereum mainnet regardless of the sending chain, since
 * that is where the registry lives. The resolved address is what the card
 * displays — a name is a claim, and the address is what actually receives.
 */
async function resolveRecipient(input: string, chainId: SupportedChainId): Promise<Address> {
  const value = input.trim();
  if (value === '') throw new Error('Give me an address to send to.');

  if (isAddress(value)) {
    const address = getAddress(value);
    if (address === '0x0000000000000000000000000000000000000000') {
      throw new Error('That is the zero address. Anything sent there is burned, so I will not build it.');
    }
    return address;
  }

  if (value.includes('.') && !value.startsWith('0x')) {
    const resolved = await publicClientFor(1)
      .getEnsAddress({ name: value.toLowerCase() })
      .catch(() => null);

    if (!resolved) {
      throw new Error(`I could not resolve "${value}" to an address. Check the name, or give me a 0x address.`);
    }
    return getAddress(resolved);
  }

  throw new Error(
    `"${value}" is not a valid address or ENS name. Give me a 0x address and I'll verify it.`,
  );
}

/** A contract recipient may not implement token receipt, stranding the funds. */
async function isContract(chainId: SupportedChainId, address: Address): Promise<boolean> {
  try {
    const code = await publicClientFor(chainId).getCode({ address });
    return code !== undefined && code !== '0x';
  } catch {
    return false;
  }
}

function transferWarnings(input: {
  symbol: string;
  recipientIsContract: boolean;
  sendsNative: boolean;
  chainId: SupportedChainId;
}): string[] {
  const warnings = [
    `A transfer cannot be undone. Check the address character by character — if it is wrong, the ${input.symbol} is gone.`,
  ];

  if (input.recipientIsContract) {
    warnings.push(
      'That address is a contract, not a regular wallet. If it does not handle incoming transfers, the funds may be stuck there permanently.',
    );
  }
  if (!input.sendsNative) {
    warnings.push(
      `Make sure the recipient can receive ${input.symbol} on ${chainName(input.chainId)} specifically — the same address on another chain is a different destination.`,
    );
  }
  return warnings;
}
