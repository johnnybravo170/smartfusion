import type { ReactNode } from 'react';

/**
 * Minimal layout for public-facing pages (no auth, no sidebar, no nav).
 * Used by the lead-gen quoting widget at /q/[slug].
 */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <main className="flex-1">{children}</main>
      <footer className="border-t py-4 text-center">
        <a
          href="https://heyhenry.io"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Powered by HeyHenry
        </a>
      </footer>
    </div>
  );
}
