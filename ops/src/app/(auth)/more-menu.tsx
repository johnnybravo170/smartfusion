'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

type Item = { href: string; label: string };

/**
 * Dropdown that closes on:
 *   - clicking the trigger again
 *   - pressing Escape
 *   - clicking outside the menu
 *   - navigating to any href in the menu (pathname change)
 *
 * Replaces the bare <details>/<summary> element which only closed on summary
 * click and stayed open after click-outside or in-menu navigation.
 */
export function MoreMenu({ items }: { items: Item[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  // Close on navigation. We reference pathname inside the body so biome's
  // exhaustive-deps check is satisfied; the actual point is the dep change
  // re-firing the effect.
  useEffect(() => {
    void pathname;
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent): void {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="cursor-pointer text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      >
        More {open ? '▴' : '▾'}
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-10 mt-2 flex w-44 flex-col gap-1 rounded-md border border-[var(--border)] bg-[var(--background)] p-1 shadow-md">
          {items.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              onClick={() => setOpen(false)}
              className="block rounded px-2 py-1.5 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
            >
              {n.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
