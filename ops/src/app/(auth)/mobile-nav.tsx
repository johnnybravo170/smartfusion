'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { SignOutButton } from './sign-out-button';

type Item = { href: string; label: string };

/**
 * Mobile-only nav drawer. Hamburger trigger + slide-in panel from the
 * right, backed by a translucent overlay. Closes on backdrop click,
 * Escape, or route change. Desktop layout uses inline nav instead — see
 * (auth)/layout.tsx.
 */
export function MobileNav({
  primary,
  more,
  email,
}: {
  primary: Item[];
  more: Item[];
  email: string;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    void pathname;
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    // Lock body scroll while drawer is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        aria-expanded={open}
        className="flex size-9 items-center justify-center rounded-md border border-[var(--border)] text-[var(--foreground)] hover:bg-[var(--muted)]"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-5"
          aria-hidden="true"
        >
          <line x1="4" y1="6" x2="20" y2="6" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="18" x2="20" y2="18" />
        </svg>
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 md:hidden">
          {/* Backdrop */}
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/40"
          />
          {/* Panel */}
          <div className="absolute right-0 top-0 flex h-full w-72 max-w-[85%] flex-col bg-[var(--background)] shadow-xl">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
              <span className="text-sm font-semibold tracking-tight">HeyHenry Ops</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className="flex size-8 items-center justify-center rounded-md hover:bg-[var(--muted)]"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="size-5"
                  aria-hidden="true"
                >
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="6" y1="18" x2="18" y2="6" />
                </svg>
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto px-2 py-3">
              <ul className="flex flex-col gap-0.5">
                {primary.map((n) => (
                  <li key={n.href}>
                    <Link
                      href={n.href}
                      className="block rounded-md px-3 py-2 text-sm text-[var(--foreground)] hover:bg-[var(--muted)]"
                    >
                      {n.label}
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="my-3 px-3 text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                More
              </div>
              <ul className="flex flex-col gap-0.5">
                {more.map((n) => (
                  <li key={n.href}>
                    <Link
                      href={n.href}
                      className="block rounded-md px-3 py-2 text-sm text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                    >
                      {n.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="border-t border-[var(--border)] px-4 py-3">
              <p className="mb-2 truncate text-xs text-[var(--muted-foreground)]" title={email}>
                {email}
              </p>
              <SignOutButton />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
