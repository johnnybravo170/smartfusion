import { HeyHenryWordmark } from '@/components/branding/heyhenry-wordmark';

/**
 * Centered auth layout used by login, signup, magic-link, check-email,
 * callback, and the onboarding plan picker. Wordmark above the card,
 * footer below — gives every auth surface a consistent HeyHenry frame
 * instead of dropping the user into a bare form.
 */

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-muted/30 p-4">
      <HeyHenryWordmark />
      <div className="w-full max-w-sm">{children}</div>
      <p className="text-xs text-muted-foreground">Built for contractors. Made in Canada.</p>
    </div>
  );
}
