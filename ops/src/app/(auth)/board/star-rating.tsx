'use client';

import { useState } from 'react';

/**
 * 1–5 star widget. Controlled. Click a star to set; click the active star
 * to clear. Hovering previews. Used for both session-level review (large)
 * and per-message advisor ratings (small).
 */
export function StarRating({
  value,
  onChange,
  size = 'md',
  disabled = false,
  ariaLabel = 'Rating',
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  size?: 'sm' | 'md';
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const display = hover ?? value ?? 0;
  const dim = size === 'sm' ? 'text-base' : 'text-xl';

  return (
    <fieldset
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-0.5 border-0 p-0 ${dim}`}
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= display;
        return (
          <button
            key={n}
            type="button"
            disabled={disabled}
            onMouseEnter={() => !disabled && setHover(n)}
            onMouseLeave={() => setHover(null)}
            onClick={() => onChange(value === n ? null : n)}
            aria-label={`${n} star${n === 1 ? '' : 's'}`}
            aria-pressed={value === n}
            className={`leading-none transition ${
              filled ? 'text-amber-500' : 'text-[var(--muted-foreground)] opacity-40'
            } ${disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:opacity-100'}`}
          >
            ★
          </button>
        );
      })}
      {value !== null ? (
        <span className="ml-2 text-xs text-[var(--muted-foreground)]">{value}/5</span>
      ) : null}
    </fieldset>
  );
}
