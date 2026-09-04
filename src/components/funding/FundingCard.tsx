'use client';

import { useState } from 'react';
import { chainName } from '@/lib/chains';
import { isFundingExit, type WalletSession } from '@/lib/wallet-session';
import { formatRate, type FundingPlan } from '@/lib/agent/handlers/funding';
import './funding.css';

/**
 * The fiat on-ramp, as a card in the transcript.
 *
 * Deliberately a button rather than an automatic open. The card appears
 * because a phrase matched, and a payment sheet that opens itself on that
 * basis is a bad idea on its own terms. The click is the consent.
 */
export function FundingCard({
  plan,
  wallet,
}: {
  readonly plan: FundingPlan;
  readonly wallet: WalletSession;
}) {
  const [isOpening, setIsOpening] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const canFund = wallet.privy !== null && wallet.isConnected;

  const onClick = async () => {
    if (!wallet.privy) return;
    setFailure(null);
    setIsOpening(true);
    try {
      await wallet.privy.addFunds({
        chainId: plan.chainId,
        asset: plan.asset,
        currency: plan.currency,
        amount: plan.amount,
      });
    } catch (cause) {
      // Closing the sheet is a decision, not a fault.
      if (!isFundingExit(cause)) setFailure('Could not open the payment flow. Try again.');
    } finally {
      setIsOpening(false);
    }
  };

  return (
    <section className="fund" aria-label={`Buy ${plan.asset}`}>
      <header className="fund-head">
        <span className="fund-kind label">
          <span className="fund-dot" aria-hidden="true" /> Buy
        </span>
        <span className="fund-route">
          {plan.currency ? plan.currency.toUpperCase() : 'Fiat'} &rarr; {plan.asset}
        </span>
      </header>

      <div className="fund-body">
        <div className="fund-figure">
          <span className="fund-eyebrow">You receive</span>
          <strong className="fund-asset num">{plan.asset}</strong>
          <span className="fund-where">on {chainName(plan.chainId)}</span>
        </div>
        <div className="fund-figure fund-figure--right">
          <span className="fund-eyebrow">You pay with</span>
          <strong className="fund-asset num">
            {plan.currency ? plan.currency.toUpperCase() : '—'}
            {plan.amount ? ` ${plan.amount}` : ''}
          </strong>
          <span className="fund-where">card or bank transfer</span>
        </div>
      </div>

      {plan.rate !== null && plan.currency && (
        <div className="fund-rate">
          <span className="fund-eyebrow">Market rate</span>
          <p className="fund-rate-line">
            <span className="num">
              1 {plan.asset} &asymp; {formatRate(plan.rate)} {plan.currency.toUpperCase()}
            </span>
            {plan.estimate !== null && (
              <span className="fund-rate-est num">
                &middot; {plan.currency.toUpperCase()} {plan.amount} buys about{' '}
                {formatRate(plan.estimate)} {plan.asset}
              </span>
            )}
          </p>
          {/*
            Said next to the number, not in a footnote. A market rate shown
            without this reads as a promise of what the user will receive, and
            the provider's fee and spread mean it is not.
          */}
          <p className="fund-rate-note">
            Live market price, not the provider&rsquo;s. Their quote adds a fee and a spread,
            so you will receive somewhat less.
          </p>
        </div>
      )}

      {plan.unsupportedCurrency && (
        <p className="fund-note fund-note--warn" role="alert">
          The on-ramp does not accept {plan.unsupportedCurrency.toUpperCase()}. It will open on
          its default currency instead.
        </p>
      )}

      <ul className="fund-terms">
        {/*
          Stated before the button, not after. Which providers and currencies
          are actually offered depends on the user's country and on Privy's
          dashboard configuration, and neither is knowable from here — so this
          promises a flow, never an outcome.
        */}
        <li>
          Handled by Privy&rsquo;s payment provider. What is offered depends on your country, and
          the provider may ask you to verify your identity.
        </li>
        <li>
          {plan.asset} is not a gas token. You will still need a little{' '}
          {plan.chainId === 137 ? 'POL' : 'ETH'} on {chainName(plan.chainId)} to transact.
        </li>
        <li>Funds arrive in your own wallet. Plumb never holds them.</li>
      </ul>

      <button
        type="button"
        className="btn-execute"
        onClick={() => void onClick()}
        disabled={!canFund || isOpening}
      >
        {isOpening ? 'Opening…' : `Buy ${plan.asset}`}
      </button>

      {!canFund && (
        <p className="fund-note">
          {wallet.isConnected
            ? 'Buying with fiat needs a Privy session. Reconnect with email, Google or a passkey.'
            : 'Connect a wallet first — the purchase is delivered straight to it.'}
        </p>
      )}
      {failure && (
        <p className="fund-note fund-note--warn" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}
