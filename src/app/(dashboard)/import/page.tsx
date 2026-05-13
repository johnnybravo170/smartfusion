import {
  ArrowRight,
  Briefcase,
  Clock,
  FileText,
  History,
  ImageIcon,
  type LucideIcon,
  Receipt,
  Sparkles,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'Import data — HeyHenry',
};

type ImportTile = {
  href: string;
  Icon: LucideIcon;
  title: string;
  blurb: string;
  examples: string;
  /** Whether the tenant already has rows of this kind. Drives the
   *  recommended-vs-already-in-system framing on the tile. */
  populated: boolean;
};

export default async function ImportHubPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) redirect('/login?next=/import');

  // Best-effort signal of how full the tenant's account already is so we
  // can recommend the next likely import. Counts are cheap; if any query
  // fails we just default to "not populated" for that kind.
  const supabase = await createClient();
  const [
    { count: customerCount },
    { count: projectCount },
    { count: invoiceCount },
    { count: expenseCount },
    { count: photoCount },
    { count: timeEntryCount },
    { count: activeBatchCount },
  ] = await Promise.all([
    supabase.from('customers').select('id', { count: 'exact', head: true }).is('deleted_at', null),
    supabase.from('projects').select('id', { count: 'exact', head: true }).is('deleted_at', null),
    supabase.from('invoices').select('id', { count: 'exact', head: true }).is('deleted_at', null),
    supabase
      .from('project_costs')
      .select('id', { count: 'exact', head: true })
      .eq('source_type', 'receipt')
      .eq('status', 'active'),
    supabase.from('photos').select('id', { count: 'exact', head: true }).is('deleted_at', null),
    supabase.from('time_entries').select('id', { count: 'exact', head: true }),
    supabase
      .from('import_batches')
      .select('id', { count: 'exact', head: true })
      .is('rolled_back_at', null),
  ]);

  const tiles: ImportTile[] = [
    {
      href: '/contacts/import',
      Icon: Users,
      title: 'Customers',
      blurb: 'A list of names with whatever contact info you have. Henry sorts the rest.',
      examples: 'QuickBooks export, Jobber CSV, Google Sheets, plain text',
      populated: (customerCount ?? 0) > 0,
    },
    {
      href: '/projects/import',
      Icon: Briefcase,
      title: 'Projects',
      blurb: 'Quotes and jobs. New customers come along automatically — no setup order.',
      examples: 'Google Sheets, Excel-as-CSV, plain text',
      populated: (projectCount ?? 0) > 0,
    },
    {
      href: '/invoices/import',
      Icon: FileText,
      title: 'Invoices',
      blurb: 'Historical invoices land with their original tax math frozen — no recompute.',
      examples: 'QuickBooks export, Jobber CSV, Excel-as-CSV',
      populated: (invoiceCount ?? 0) > 0,
    },
    {
      href: '/expenses/import',
      Icon: Receipt,
      title: 'Receipts',
      blurb: 'Drop a stack of PDFs or photos. Henry reads each one and pre-files it by category.',
      examples: 'Scanned PDFs, phone photos — drop 50 at once',
      populated: (expenseCount ?? 0) > 0,
    },
    {
      href: '/photos/import',
      Icon: ImageIcon,
      title: 'Project photos',
      blurb: 'Drop a folder of historical project photos. Henry tags them in the background.',
      examples: 'JPEG, PNG, HEIC, WebP — pick a project, drop the lot',
      populated: (photoCount ?? 0) > 0,
    },
    {
      href: '/time/import',
      Icon: Clock,
      title: 'Time entries',
      blurb: 'Historical hours by worker / project / date. Henry matches workers to your team.',
      examples: 'Payroll CSV, time-tracking export, Google Sheets',
      populated: (timeEntryCount ?? 0) > 0,
    },
  ];

  // Suggest the natural onboarding order: customers first, then
  // projects, invoices, receipts. The tile that's still empty AND
  // earliest in the order is the recommended next step.
  const recommendedIndex = tiles.findIndex((t) => !t.populated);
  const allPopulated = recommendedIndex === -1;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Sparkles className="size-4" />
          Day-1 onboarding
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Bring your data in</h1>
        <p className="text-sm text-muted-foreground">
          Henry handles whatever shape your data is in — exports from QuickBooks/Jobber, spreadsheet
          rows, plain-text lists, scanned receipts. Pick what you want to bring in; you can always
          come back and add more.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {tiles.map((t, i) => {
          const isRecommended = i === recommendedIndex;
          return (
            <Link key={t.href} href={t.href} className="block">
              <Card className="h-full transition-colors hover:bg-muted/40">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <t.Icon className="size-5 text-muted-foreground" />
                      <CardTitle className="text-base">{t.title}</CardTitle>
                      {isRecommended ? (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                          Start here
                        </span>
                      ) : t.populated ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-900">
                          Already added
                        </span>
                      ) : null}
                    </div>
                    <ArrowRight className="size-4 text-muted-foreground" />
                  </div>
                  <CardDescription className="mt-2 text-sm">{t.blurb}</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground">{t.examples}</p>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4 text-sm">
        <div className="flex items-start gap-3">
          <History className="mt-0.5 size-4 text-muted-foreground" />
          <div>
            <p className="font-medium">Already brought something in?</p>
            <p className="text-xs text-muted-foreground">
              Every batch is logged and rolled-back-able from the imports list.
            </p>
          </div>
        </div>
        <Link
          href="/settings/imports"
          className="text-xs font-medium uppercase tracking-wide hover:underline"
        >
          {activeBatchCount && activeBatchCount > 0 ? `${activeBatchCount} active` : 'View imports'}{' '}
          →
        </Link>
      </div>

      {allPopulated ? (
        <p className="text-xs text-muted-foreground">
          Looks like every kind already has rows. You can still re-import to top up — Henry
          dedup&rsquo;s everything before any commit.
        </p>
      ) : null}
    </div>
  );
}
