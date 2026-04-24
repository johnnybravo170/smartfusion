import { Hammer } from 'lucide-react';
import { requireBookkeeper } from '@/lib/auth/helpers';

export const metadata = {
  title: 'T4A / vendors — Bookkeeper — HeyHenry',
};

export default async function BookkeeperT4aPage() {
  await requireBookkeeper();

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">T4A / vendors</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Year-end vendor roll-up. Not built yet.
        </p>
      </header>

      <div className="flex flex-col items-center gap-3 rounded-md border border-dashed bg-muted/10 py-16 text-center">
        <Hammer className="size-8 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">Coming soon</p>
          <p className="text-xs text-muted-foreground">
            Will aggregate all paid vendors (expense + bill side) with YTD totals and flag anyone
            over the $500 CRA T4A threshold. Track1099 e-file integration follows.
          </p>
        </div>
      </div>
    </div>
  );
}
