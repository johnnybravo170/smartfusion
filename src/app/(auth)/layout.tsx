/**
 * Minimal centered layout for all auth pages (login, signup, magic link,
 * check email). No nav chrome. The dashboard layout lives under a
 * different route group.
 */

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
