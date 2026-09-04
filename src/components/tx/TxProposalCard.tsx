'use client';

import { useEffect, useState } from 'react';
import { chainName, explorerTxUrl } from '@/lib/chains';
import {
  formatCompactUsd, formatDuration, formatFeeUsd, formatPercent,
  formatTokenAmount, formatUsd, shortAddress,
} from '@/lib/format';
import { useTxExecutor } from '@/hooks/useTxExecutor';
import type { WalletSession } from '@/lib/wallet-session';
import type { TxProposal } from '@/types/tx';
import './tx.css';

interface TxProposalCardProps {
  readonly proposal: TxProposal;
  readonly wallet: WalletSession;
}

export function TxProposalCard({ proposal, wallet }: TxProposalCardProps) {
  const executor = useTxExecutor(wallet);
  const [secondsLeft, setSecondsLeft] = useState(() => remaining(proposal.expiresAt));
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setSecondsLeft(remaining(proposal.expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [proposal.expiresAt]);

  const isExpired = secondsLeft <= 0;
  const isSettled = proposal.steps.every((s) => executor.states[s.id]?.status === 'confirmed');
  const hasStarted = proposal.steps.some((s) => executor.states[s.id] !== undefined);

  const onExecute = async () => {
    setSubmitError(null);
    try {
      await executor.execute(proposal);
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : 'Could not start execution.');
    }
  };

  return (
    <section className={`tx-card tx-card--${proposal.kind}`} aria-label={`${proposal.kind} proposal`}>
      <header className="tx-head">
        <span className="tx-kind">{proposal.kind}</span>
        <span className="tx-route num">{proposal.route}</span>
      </header>

      {!proposal.isSelfCustody && proposal.kind !== 'transfer' && (
        <p className="tx-alert" role="alert">
          <strong>Funds leave your wallet.</strong> The output goes to{' '}
          <span className="num">{proposal.recipient}</span>, which is not the address
          you are connected with. Reject this unless you asked for it.
        </p>
      )}

      {proposal.position ? (
        <PositionLegs position={proposal.position} />
      ) : proposal.kind === 'transfer' ? (
        <TransferLegs proposal={proposal} />
      ) : proposal.vault ? (
        <VaultLegs proposal={proposal} vault={proposal.vault} />
      ) : (
        <div className="tx-legs">
          <Leg label="You pay" asset={proposal.from} amount={proposal.from.amount} />
          <span className="tx-arrow" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.7"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <Leg label="You receive" asset={proposal.to} amount={proposal.to.amount} emphasis />
        </div>
      )}

      {proposal.position && (
        <dl className="tx-facts">
          <Fact term="Margin at risk">
            <span className="num">{formatUsd(proposal.position.marginUsd)}</span>
          </Fact>
          <Fact term="Entry">
            <span className="num">{formatUsd(proposal.position.entryPrice)}</span>
          </Fact>
          <Fact term="Max slippage">
            <span className="num">{(proposal.slippageBps / 100).toFixed(1)}%</span>
          </Fact>
          {proposal.position.builderFeePct !== null && (
            <Fact term="App fee">
              <span className="num">{proposal.position.builderFeePct}%</span>
            </Fact>
          )}
        </dl>
      )}

      {proposal.kind !== 'transfer' && !proposal.position && (
      <dl className="tx-facts">
        <Fact term={proposal.vault ? 'Vault shares' : 'Minimum received'}>
          <span className="num">
            {formatTokenAmount(BigInt(proposal.minReceived), proposal.to.decimals)} {proposal.to.symbol}
          </span>
        </Fact>
        {!proposal.vault && (
          <Fact term="Max slippage">
            <span className="num">{(proposal.slippageBps / 100).toFixed(2)}%</span>
          </Fact>
        )}
        {proposal.vault?.totalAssetsUsd !== undefined && (
          <Fact term="Vault size">
            <span className="num">{formatCompactUsd(proposal.vault.totalAssetsUsd)}</span>
          </Fact>
        )}
        {proposal.priceImpactPct !== undefined && (
          <Fact term="Price impact" tone={proposal.priceImpactPct > 1 ? 'warn' : undefined}>
            <span className="num">{proposal.priceImpactPct.toFixed(2)}%</span>
          </Fact>
        )}
        {/* Vault actions are not quoted for gas, so an empty fee row would be
            noise rather than information. Trades always show one. */}
        {(proposal.estimatedGasUsd !== undefined || !proposal.vault) && (
          <Fact term={proposal.kind === 'bridge' ? 'Fees' : 'Network fee'}>
            <span className="num">{formatFeeUsd(proposal.estimatedGasUsd)}</span>
          </Fact>
        )}
        {proposal.estimatedSeconds !== undefined && (
          <Fact term="Est. time">
            <span className="num">{formatDuration(proposal.estimatedSeconds)}</span>
          </Fact>
        )}
      </dl>
      )}

      {proposal.warnings.length > 0 && (
        <ul className="tx-warnings">
          {proposal.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      <ol className="tx-steps">
        {proposal.steps.map((step, index) => {
          const state = executor.states[step.id] ?? { status: 'idle' as const };
          return (
            <li key={step.id} className={`tx-step tx-step--${state.status}`}>
              <span className="tx-step-index num">{index + 1}</span>
              <div className="tx-step-body">
                <p className="tx-step-label">{step.label}</p>
                <p className="tx-step-detail">{step.detail}</p>
                {state.error && <p className="tx-step-error">{state.error}</p>}
                {state.hash && step.execute.via === 'transaction' && (
                  <a
                    className="tx-step-link num"
                    href={explorerTxUrl(step.execute.tx.chainId, state.hash)}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {shortAddress(state.hash)} ↗
                  </a>
                )}
              </div>
              <span className="tx-step-status">{statusLabel(state.status)}</span>
            </li>
          );
        })}
      </ol>

      <footer className="tx-foot">
        {isSettled ? (
          <p className="tx-done">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="m5 13 4 4L19 7" stroke="currentColor" strokeWidth="2.4"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            All steps confirmed on {chainName(proposal.to.chainId)}.
          </p>
        ) : (
          <>
            <button
              type="button"
              className="btn-execute"
              onClick={onExecute}
              disabled={!wallet.isConnected || executor.isRunning || (isExpired && !hasStarted)}
            >
              {!wallet.isConnected
                ? 'Connect a wallet to continue'
                : executor.isRunning
                  ? 'Awaiting your wallet…'
                  : isExpired
                    ? 'Quote expired — ask again'
                    : `Review & sign ${proposal.steps.length} transaction${proposal.steps.length > 1 ? 's' : ''}`}
            </button>
            {proposal.kind !== 'transfer' && !isExpired && !executor.isRunning && (
              <span className="tx-expiry num" aria-live="off">
                Quote valid {secondsLeft}s
              </span>
            )}
          </>
        )}
        {submitError && <p className="tx-step-error" role="alert">{submitError}</p>}
      </footer>
    </section>
  );
}

/**
 * A leveraged position. Liquidation leads, because it is the only number on
 * this card that describes losing everything, and it is what the size and
 * leverage above it actually determine.
 */
function PositionLegs({ position }: { position: NonNullable<TxProposal['position']> }) {
  const near = position.liquidationDistancePct !== null && position.liquidationDistancePct < 10;

  return (
    <div className="tx-position">
      <div className="tx-position-head">
        <span className={`tx-side tx-side--${position.isLong ? 'long' : 'short'}`}>
          {position.isLong ? 'Long' : 'Short'}
        </span>
        <span className="tx-position-size num">
          {position.sizeUnits} {position.coin}
        </span>
        <span className="tx-position-lev num">{position.leverage}×</span>
      </div>

      <p className="tx-position-notional num">
        {formatUsd(position.notionalUsd)} exposure from {formatUsd(position.marginUsd)} of margin
      </p>

      {position.liquidationPrice !== null && (
        <div className={`tx-liq${near ? ' is-near' : ''}`}>
          <span className="tx-leg-label">Estimated liquidation</span>
          <span className="tx-liq-price num">{formatUsd(position.liquidationPrice)}</span>
          {position.liquidationDistancePct !== null && (
            <span className="tx-liq-distance num">
              a {position.liquidationDistancePct.toFixed(1)}% move against you
            </span>
          )}
          <span className="tx-liq-note">
            Estimate only — it ignores fees and funding. The exchange&rsquo;s figure appears once
            the position is open.
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * A transfer has one number and one destination, and the destination is the
 * part that loses money when it is wrong. It is shown in full, never
 * truncated — an address a user cannot read character by character is an
 * address they cannot check.
 */
function TransferLegs({ proposal }: { proposal: TxProposal }) {
  return (
    <div className="tx-transfer">
      <div className="tx-transfer-amount">
        <span className="tx-leg-label">You send</span>
        <span className="tx-leg-amount num">
          {formatTokenAmount(BigInt(proposal.from.amount), proposal.from.decimals)}
        </span>
        <span className="tx-leg-symbol">{proposal.from.symbol}</span>
        <span className="tx-leg-chain">on {chainName(proposal.from.chainId)}</span>
        {proposal.from.amountUsd !== undefined && (
          <span className="tx-leg-usd num">≈ {formatUsd(proposal.from.amountUsd)}</span>
        )}
      </div>

      <div className="tx-transfer-to">
        <span className="tx-leg-label">To this address</span>
        <span className="tx-transfer-address num">{proposal.recipient}</span>
      </div>
    </div>
  );
}

/**
 * Deposits and withdrawals lead with the rate, not with a second amount: what
 * the user is deciding is whether the yield is worth the risk, and a share
 * count tells them nothing about that.
 */
function VaultLegs({ proposal, vault }: { proposal: TxProposal; vault: NonNullable<TxProposal['vault']> }) {
  const isDeposit = proposal.kind === 'deposit';

  return (
    <div className="tx-vault">
      <div className="tx-vault-primary">
        <span className="tx-leg-label">{isDeposit ? 'You deposit' : 'You withdraw'}</span>
        <span className="tx-leg-amount num">
          {formatTokenAmount(BigInt(proposal.from.amount), proposal.from.decimals)}
        </span>
        <span className="tx-leg-symbol">{proposal.from.symbol}</span>
        {proposal.from.amountUsd !== undefined && (
          <span className="tx-leg-usd num">≈ {formatUsd(proposal.from.amountUsd)}</span>
        )}
      </div>

      <div className="tx-vault-rate">
        <span className="tx-leg-label">{isDeposit ? 'Earning' : 'Was earning'}</span>
        <span className="tx-vault-apy num">{formatPercent(vault.apy)}</span>
        <span className="tx-leg-symbol">net APY, variable</span>
        {isDeposit && vault.projectedYearlyUsd !== undefined && (
          <span className="tx-leg-usd num">
            ≈ {formatUsd(vault.projectedYearlyUsd)} / yr at today&rsquo;s rate
          </span>
        )}
      </div>

      <p className="tx-vault-name">
        <span>{vault.name}</span>
        {vault.curator && <span className="tx-vault-curator">Curated by {vault.curator}</span>}
      </p>
    </div>
  );
}

function Leg({
  label, asset, amount, emphasis = false,
}: {
  label: string;
  asset: TxProposal['from'];
  amount: string;
  emphasis?: boolean;
}) {
  return (
    <div className={`tx-leg${emphasis ? ' tx-leg--out' : ''}`}>
      <span className="tx-leg-label">{label}</span>
      <span className="tx-leg-amount num">{formatTokenAmount(BigInt(amount), asset.decimals)}</span>
      <span className="tx-leg-symbol">{asset.symbol}</span>
      <span className="tx-leg-chain">on {chainName(asset.chainId)}</span>
      {asset.amountUsd !== undefined && (
        <span className="tx-leg-usd num">≈ {formatUsd(asset.amountUsd)}</span>
      )}
    </div>
  );
}

function Fact({
  term, children, tone,
}: {
  term: string;
  children: React.ReactNode;
  tone?: 'warn';
}) {
  return (
    <div className={`tx-fact${tone ? ` tx-fact--${tone}` : ''}`}>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case 'awaiting-signature': return 'Sign in wallet';
    case 'pending': return 'Confirming';
    case 'confirmed': return 'Confirmed';
    case 'failed': return 'Failed';
    default: return 'Waiting';
  }
}

function remaining(expiresAt: number): number {
  return Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
}
