'use client';

import { useEffect, useState } from 'react';

/**
 * Tracks the viewer's motion preference, and keeps tracking it — the setting
 * can change mid-session, and a one-shot read would strand the page in
 * whatever state it started in.
 *
 * Defaults to `false` so the server-rendered HTML is stable; the real value
 * arrives on mount.
 */
export function useReducedMotion(): boolean {
  const [prefersReduced, setPrefersReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReduced(query.matches);

    const onChange = (event: MediaQueryListEvent) => setPrefersReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return prefersReduced;
}
