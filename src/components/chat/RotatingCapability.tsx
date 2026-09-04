'use client';

import { useEffect, useState } from 'react';
import { useReducedMotion } from '@/hooks/useReducedMotion';

/**
 * What Plumb can actually do, phrased as completions of "Plumb can —".
 * Each one names a real capability backed by a tool, so the line doubles as
 * documentation rather than decoration.
 */
const CAPABILITIES = [
  'swap tokens on any chain',
  'bridge in a single signature',
  'earn yield through Morpho',
  'find where the best rate is',
  'explain what the risk really is',
] as const;

/**
 * Splits a phrase into words, each carrying the index of its first letter so
 * the per-letter stagger stays continuous across word boundaries.
 */
function splitWords(phrase: string): { word: string; offset: number }[] {
  const words: { word: string; offset: number }[] = [];
  let offset = 0;
  // The trailing space is kept on the preceding word so the gap animates with
  // it and the words do not collapse together.
  for (const word of phrase.split(' ')) {
    const isLast = offset + word.length >= phrase.length;
    const chunk = isLast ? word : `${word} `;
    words.push({ word: chunk, offset });
    offset += chunk.length;
  }
  return words;
}

const HOLD_MS = 2600;
const LETTER_STAGGER_MS = 22;
const EXIT_MS = 260;

export function RotatingCapability() {
  const prefersReduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [isLeaving, setIsLeaving] = useState(false);

  useEffect(() => {
    // Honour the motion preference by holding one phrase rather than cycling.
    if (prefersReduced) return;

    const hold = setTimeout(() => setIsLeaving(true), HOLD_MS);
    return () => clearTimeout(hold);
  }, [index, prefersReduced]);

  useEffect(() => {
    if (!isLeaving) return;
    const swap = setTimeout(() => {
      setIndex((current) => (current + 1) % CAPABILITIES.length);
      setIsLeaving(false);
    }, EXIT_MS);
    return () => clearTimeout(swap);
  }, [isLeaving]);

  const phrase = CAPABILITIES[index] ?? CAPABILITIES[0];

  return (
    <span className="capability">
      {/*
        * Screen readers get the whole list as ordinary prose. The animated
        * copy is split into per-letter elements, which assistive technology
        * would otherwise announce one character at a time.
        */}
      <span className="visually-hidden">
        Plumb can {CAPABILITIES.join(', ')}.
      </span>

      <span className="capability-lead" aria-hidden="true">
        Plumb can
      </span>

      <span className={`capability-phrase${isLeaving ? ' is-leaving' : ''}`} aria-hidden="true">
        {/* Keyed by phrase so React remounts the letters and replays the stagger. */}
        {[...phrase].map((character, position) => (
          <span
            key={`${index}-${position}`}
            className="capability-letter"
            style={{ animationDelay: `${position * LETTER_STAGGER_MS}ms` }}
          >
            {character === ' ' ? ' ' : character}
          </span>
        ))}
      </span>
    </span>
  );
}
