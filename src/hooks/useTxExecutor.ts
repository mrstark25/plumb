'use client';

import { useCallback, useState } from 'react';
import type { Address, Hex, WalletClient } from 'viem';
import { isSupportedChainId } from '@/lib/chains';
import { publicClientForChain } from '@/lib/client-rpc';
import { agentAccount, loadAgent } from '@/lib/hyperliquid/agent-wallet';
import { l1TypedData, splitSignature } from '@/lib/hyperliquid/sign';
import type {
  AgentSignedRequest, SignedRequest, TxProposal, TxRequest, TxStep,
} from '@/types/tx';
import type { WalletSession } from '@/lib/wallet-session';

export type StepStatus = 'idle' | 'awaiting-signature' | 'pending' | 'confirmed' | 'failed';

/** Where a signed-and-relayed action is sent. */
const RELAY_ENDPOINT = '/api/relay';

export interface StepState {
  readonly status: StepStatus;
  readonly hash?: Hex;
  readonly error?: string;
}

type Wallet = WalletSession;

/**
 * Executes a proposal's steps in order, one wallet signature at a time, and
 * waits for each receipt before moving on — an approval that is still pending
 * would make the swap that follows it revert.
 */
export function useTxExecutor(wallet: Wallet) {
  const [states, setStates] = useState<Record<string, StepState>>({});
  const [isRunning, setIsRunning] = useState(false);

  const setStep = useCallback((id: string, next: StepState) => {
    setStates((prev) => ({ ...prev, [id]: next }));
  }, []);

  const execute = useCallback(
    async (proposal: TxProposal) => {
      if (!wallet.walletClient || !wallet.address) {
        throw new Error('Connect a wallet before executing.');
      }
      if (Date.now() > proposal.expiresAt) {
        throw new Error('This quote has expired. Ask for a fresh one before signing.');
      }

      setIsRunning(true);
      try {
        for (const step of proposal.steps) {
          const ok = await runStep(step);
          if (!ok) return false;
        }
        return true;
      } finally {
        setIsRunning(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallet.walletClient, wallet.address, wallet.chainId],
  );

  const runStep = useCallback(
    async (step: TxStep): Promise<boolean> => {
      const client = wallet.walletClient;
      const account = wallet.address;
      if (!client || !account) return false;

      try {
        switch (step.execute.via) {
          case 'transaction':
            return await sendTransactionStep(step, step.execute.tx, client, account);
          case 'wallet-sign':
            return await relaySignedStep(step, step.execute.request, client, account);
          case 'agent-sign':
            return await relayAgentStep(step, step.execute.request);
        }
      } catch (cause) {
        setStep(step.id, { status: 'failed', error: describeFailure(cause) });
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallet, setStep],
  );

  /** Broadcasts an EVM transaction and waits for it to be mined. */
  const sendTransactionStep = useCallback(
    async (step: TxStep, tx: TxRequest, client: WalletClient, account: Address) => {
      const { chainId } = tx;
      if (!isSupportedChainId(chainId)) {
        setStep(step.id, { status: 'failed', error: `Unsupported chain ${chainId}.` });
        return false;
      }

      // A step may target a different chain than the one currently selected
      // (bridges always do). Move the wallet before asking for a signature.
      if (wallet.chainId !== chainId) await wallet.switchChain(chainId);

      setStep(step.id, { status: 'awaiting-signature' });

      /*
       * An embedded wallet has no extension to raise a confirmation, so Privy
       * renders one itself and handles nonce and gas. Everything else — an
       * extension, whether discovered directly or through Privy — keeps
       * signing where the user expects to sign.
       */
      const privySend = wallet.privy?.sendTransaction;
      const hash = privySend
        ? await privySend(tx)
        : await client.sendTransaction({
            account,
            chain: null,
            to: tx.to,
            data: tx.data,
            value: BigInt(tx.value),
            ...(tx.gasLimit ? { gas: BigInt(tx.gasLimit) } : {}),
          });

      setStep(step.id, { status: 'pending', hash });
      const receipt = await publicClientForChain(chainId).waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });

      if (receipt.status !== 'success') {
        setStep(step.id, { status: 'failed', hash, error: 'Transaction reverted on-chain.' });
        return false;
      }
      setStep(step.id, { status: 'confirmed', hash });
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallet, setStep],
  );

  /**
   * Signs an L1 action with the browser's agent key and relays it.
   *
   * No wallet popup: the user's wallet physically cannot sign these, and the
   * agent key exists precisely to fill that gap. The action is hashed here, in
   * the browser, so the server cannot substitute a different one.
   */
  const relayAgentStep = useCallback(
    async (step: TxStep, request: AgentSignedRequest) => {
      const master = wallet.address;
      if (!master) return false;

      const stored = loadAgent(master);
      if (!stored) {
        setStep(step.id, {
          status: 'failed',
          error: 'No trading agent found for this wallet. Authorise one and try again.',
        });
        return false;
      }

      setStep(step.id, { status: 'pending' });

      const typedData = l1TypedData({
        action: request.action,
        nonce: request.nonce,
        isMainnet: request.isMainnet,
      });
      const signature = splitSignature(
        await agentAccount(stored).signTypedData(typedData as never),
      );

      return postToRelay(step, {
        action: request.action,
        nonce: request.nonce,
        signature,
        vaultAddress: null,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallet.address, setStep],
  );

  /**
   * Signs an off-chain action and relays it through our own API.
   *
   * There is no transaction hash and no receipt here — the exchange either
   * accepts the action or rejects it, and its answer is the only confirmation
   * that exists. The relay goes through our server so the browser never needs
   * the exchange origin in its CSP.
   */
  const relaySignedStep = useCallback(
    async (step: TxStep, request: SignedRequest, client: WalletClient, account: Address) => {
      setStep(step.id, { status: 'awaiting-signature' });

      const signature = await client.signTypedData({
        account,
        domain: request.typedData.domain,
        types: request.typedData.types,
        primaryType: request.typedData.primaryType,
        message: request.typedData.message,
      } as never);

      setStep(step.id, { status: 'pending' });

      return postToRelay(step, {
        action: request.action,
        nonce: request.nonce,
        signature: splitSignature(signature),
        vaultAddress: request.vaultAddress,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setStep],
  );

  /** Sends a finished signature to the relay and reports what came back. */
  const postToRelay = useCallback(
    async (step: TxStep, payload: unknown) => {
      const response = await fetch(RELAY_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;

      if (!response.ok || body?.ok === false) {
        setStep(step.id, {
          status: 'failed',
          error: body?.error ?? 'The exchange rejected the action.',
        });
        return false;
      }

      setStep(step.id, { status: 'confirmed' });
      return true;
    },
    [setStep],
  );

  const reset = useCallback(() => setStates({}), []);

  return { states, isRunning, execute, reset };
}

function describeFailure(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const code = (cause as { code: unknown }).code;
    if (code === 4001) return 'You rejected the request in your wallet.';
    if (code === -32000) return 'Insufficient funds for gas.';
  }
  if (cause instanceof Error) {
    // viem error messages are long; the first line carries the useful part.
    return cause.message.split('\n')[0] ?? cause.message;
  }
  return 'The transaction could not be sent.';
}
