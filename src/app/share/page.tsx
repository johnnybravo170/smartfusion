import { AlertCircle, FileText, FolderKanban } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { listProjects } from '@/lib/db/queries/projects';

/**
 * Project-picker landing page for the Web Share Target flow. Operator
 * got here after sharing a file (or text) from iOS Share Sheet. They
 * pick the destination project; we forward them to that project's
 * intake zone with a `?share=<token>` param the intake reads on mount
 * to pre-stage the shared file.
 *
 * See `src/app/share/receive/route.ts` for the POST-side that stashed
 * the file in `share-drafts` storage and redirected here.
 */
export const dynamic = 'force-dynamic';

const ERROR_MESSAGES: Record<string, string> = {
  no_form: "We didn't receive a file — try sharing it again.",
  too_big: 'That file is larger than 10MB. Shrink or split it and try again.',
  upload: 'The upload failed. Try again.',
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function SharePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const tenant = await getCurrentTenant();
  if (!tenant) redirect('/login?next=/share');

  const params = await searchParams;
  const token = typeof params.f === 'string' ? params.f : null;
  const fileName = typeof params.name === 'string' ? params.name : null;
  const sharedText = typeof params.t === 'string' ? params.t : null;
  const sharedUrl = typeof params.u === 'string' ? params.u : null;
  const errorCode = typeof params.err === 'string' ? params.err : null;

  const projects = await listProjects({ limit: 200 });
  const active = projects.filter((p) => p.status === 'planning' || p.status === 'in_progress');

  return (
    <div className="mx-auto max-w-lg p-4">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Share to HeyHenry</h1>
        <p className="text-sm text-muted-foreground">
          Pick a project. The file gets dropped into that project&apos;s intake zone so Henry can
          parse it.
        </p>
      </div>

      {errorCode ? (
        <Card className="mb-4 border-destructive/30 bg-destructive/5">
          <CardContent className="flex items-start gap-2 py-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 flex-shrink-0" />
            <p>{ERROR_MESSAGES[errorCode] ?? 'Something went wrong.'}</p>
          </CardContent>
        </Card>
      ) : null}

      {token && fileName ? (
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <FileText className="size-4 text-muted-foreground" />
              <CardTitle className="text-sm">Shared file</CardTitle>
            </div>
            <CardDescription className="truncate">{fileName}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {(sharedText || sharedUrl) && !token ? (
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Shared text / link</CardTitle>
            <CardDescription className="text-xs">
              Pick a project to drop this into notes. (Only files are parsed by Henry today; text
              still lands in the project timeline.)
            </CardDescription>
          </CardHeader>
          <CardContent className="py-2">
            {sharedText ? <p className="text-sm">{sharedText}</p> : null}
            {sharedUrl ? (
              <p className="mt-1 break-all text-xs text-muted-foreground">{sharedUrl}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Active projects ({active.length})
        </p>
        {active.length === 0 ? (
          <p className="rounded-md border border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground">
            No active projects. Create one first, then try sharing again.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {active.map((p) => {
              const href = buildHref({
                projectId: p.id,
                token,
                fileName,
                sharedText,
                sharedUrl,
              });
              return (
                <Link
                  key={p.id}
                  href={href}
                  className="group flex items-center gap-3 rounded-md border bg-card px-3 py-3 transition-colors hover:bg-muted/50"
                >
                  <FolderKanban className="size-4 flex-shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{p.name}</p>
                    {p.customer?.name ? (
                      <p className="truncate text-xs text-muted-foreground">{p.customer.name}</p>
                    ) : null}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function buildHref(args: {
  projectId: string;
  token: string | null;
  fileName: string | null;
  sharedText: string | null;
  sharedUrl: string | null;
}): string {
  const sp = new URLSearchParams();
  sp.set('tab', 'overview');
  sp.set('intake', 'open');
  if (args.token) sp.set('share', args.token);
  if (args.fileName) sp.set('share_name', args.fileName);
  if (args.sharedText) sp.set('share_text', args.sharedText);
  if (args.sharedUrl) sp.set('share_url', args.sharedUrl);
  return `/projects/${args.projectId}?${sp.toString()}`;
}
