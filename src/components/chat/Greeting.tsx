'use client';

import { RotatingCapability } from './RotatingCapability';

const PROMPTS = [
  { kind: 'Swap', text: 'Swap 0.1 ETH to USDC on Base' },
  { kind: 'Bridge', text: 'Bridge 500 USDC from Arbitrum to Base' },
  { kind: 'Earn', text: 'Deposit 1000 USDC into the best Morpho vault' },
  { kind: 'Ask', text: 'Where can I get the best yield if I have $1000?' },
] as const;

interface GreetingProps {
  readonly onSend: (text: string) => void;
}

/**
 * The opening screen. It always greets, because the first thing a user needs
 * to know is that this agent takes instructions in plain English — an empty
 * transcript communicates nothing.
 */
export function Greeting({ onSend }: GreetingProps) {
  return (
    <section className="greeting">
      {/*
        The plumb line drops from the top rule down the left of the opening
        block, and the heading hangs off it. Structure you can see: the same
        vertical the wordmark's bob is measuring.
      */}
      <div className="greeting-head">
        <span className="greeting-index label" aria-hidden="true">
          01 <span className="greeting-index-rule" /> Ready
        </span>

        <h2 className="greeting-title">
          <RotatingCapability />
        </h2>
      </div>

      <p className="greeting-lede">
        Tell me what you want to do on-chain and I&rsquo;ll price it, explain the
        trade-offs, and hand your wallet a transaction to sign.
      </p>

      <ul className="greeting-prompts">
        {PROMPTS.map((prompt, position) => (
          <li key={prompt.text}>
            <button type="button" className="greeting-prompt" onClick={() => onSend(prompt.text)}>
              <span className="greeting-prompt-no" aria-hidden="true">
                {String(position + 1).padStart(2, '0')}
              </span>
              <span className="greeting-prompt-kind">{prompt.kind}</span>
              <span className="greeting-prompt-text">{prompt.text}</span>
              <span className="greeting-prompt-go" aria-hidden="true">&rarr;</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

