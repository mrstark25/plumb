'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

interface ComposerProps {
  readonly onSend: (text: string) => void;
  readonly isThinking: boolean;
  readonly onStop: () => void;
}

export function Composer({ onSend, isThinking, onStop }: ComposerProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grow with content up to a ceiling, then scroll internally.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!value.trim() || isThinking) return;
    onSend(value);
    setValue('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) submit();
  };

  return (
    <div className="composer-region">
      <form className="composer" onSubmit={submit}>
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Swap, bridge, or ask about yield…"
          aria-label="Message Plumb"
          disabled={isThinking}
        />
        {isThinking ? (
          <button type="button" className="composer-send" onClick={onStop} aria-label="Stop generating">
            <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button
            type="submit"
            className="composer-send"
            disabled={!value.trim()}
            aria-label="Send message"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 12h15M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </form>

      <p className="composer-note">
        Plumb builds transactions; your wallet signs them. Always read the
        confirmation card before approving.
      </p>
    </div>
  );
}
