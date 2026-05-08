'use client';

/**
 * Operator-side document list grouped by type. Each row shows title +
 * size + uploaded date + optional expiry, with Delete and a "Hidden
 * from homeowner" toggle.
 */

import { Eye, EyeOff, FileText, Loader2, Trash2 } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import type { ProjectDocumentWithUrl } from '@/lib/db/queries/project-documents';
import { cn } from '@/lib/utils';
import {
  DOCUMENT_TYPE_DISPLAY_ORDER,
  type DocumentType,
  documentTypeLabels,
} from '@/lib/validators/project-document';
import {
  deleteProjectDocumentAction,
  setDocumentClientVisibleAction,
} from '@/server/actions/project-documents';

function humanBytes(n: number | null): string {
  if (!n || n <= 0) return '';
  const k = 1024;
  if (n < k) return `${n} B`;
  if (n < k * k) return `${(n / k).toFixed(1)} KB`;
  return `${(n / k / k).toFixed(1)} MB`;
}

export function DocumentList({
  documents,
  projectId,
}: {
  documents: ProjectDocumentWithUrl[];
  projectId: string;
}) {
  if (documents.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No documents yet. Upload contracts, permits, warranties, manuals — they&rsquo;ll appear on
        the homeowner&rsquo;s portal and in the final Home Record.
      </p>
    );
  }

  // Bucket by type, ordered by display preference.
  const buckets = new Map<DocumentType, ProjectDocumentWithUrl[]>();
  for (const doc of documents) {
    const list = buckets.get(doc.type) ?? [];
    list.push(doc);
    buckets.set(doc.type, list);
  }
  const orderedTypes = DOCUMENT_TYPE_DISPLAY_ORDER.filter((t) => (buckets.get(t)?.length ?? 0) > 0);

  return (
    <div className="space-y-4">
      {orderedTypes.map((type) => {
        const docs = buckets.get(type) ?? [];
        return (
          <div key={type} className="rounded-lg border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-2">
              <h3 className="text-sm font-semibold">
                {documentTypeLabels[type]}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {docs.length}
                </span>
              </h3>
            </div>
            <ul className="divide-y">
              {docs.map((d) => (
                <DocumentRow key={d.id} doc={d} projectId={projectId} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function DocumentRow({ doc, projectId }: { doc: ProjectDocumentWithUrl; projectId: string }) {
  const tz = useTenantTimezone();
  const [pending, startTransition] = useTransition();

  function onToggleVisibility() {
    const next = !doc.client_visible;
    startTransition(async () => {
      const res = await setDocumentClientVisibleAction(doc.id, projectId, next);
      if (!res.ok) toast.error(res.error);
    });
  }

  function onDelete() {
    if (!confirm(`Delete "${doc.title}"? This can't be undone.`)) return;
    startTransition(async () => {
      const res = await deleteProjectDocumentAction(doc.id, projectId);
      if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        {doc.url ? (
          <a
            href={doc.url}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-sm font-medium hover:underline"
            title={doc.title}
          >
            {doc.title}
          </a>
        ) : (
          <span className="block truncate text-sm font-medium">{doc.title}</span>
        )}
        <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {humanBytes(doc.bytes) ? <span>{humanBytes(doc.bytes)}</span> : null}
          <span>
            Added{' '}
            {new Intl.DateTimeFormat('en-CA', {
              timeZone: tz,
              month: 'short',
              day: 'numeric',
            }).format(new Date(doc.created_at))}
          </span>
          {doc.expires_at ? (
            <span>
              Expires{' '}
              {new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(doc.expires_at))}
            </span>
          ) : null}
          {!doc.client_visible ? <span className="font-medium">Hidden from homeowner</span> : null}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={doc.client_visible ? 'Hide from homeowner' : 'Show to homeowner'}
          title={doc.client_visible ? 'Hide from homeowner' : 'Show to homeowner'}
          onClick={onToggleVisibility}
          disabled={pending}
          className={cn(!doc.client_visible && 'text-muted-foreground/60')}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : doc.client_visible ? (
            <Eye className="size-4" />
          ) : (
            <EyeOff className="size-4" />
          )}
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Delete document"
          onClick={onDelete}
          disabled={pending}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </li>
  );
}
