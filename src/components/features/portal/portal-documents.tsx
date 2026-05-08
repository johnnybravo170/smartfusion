/**
 * Read-only "Documents & warranties" panel on the homeowner portal.
 * Server-rendered (no client JS).
 *
 * Manuals + warranties get top placement; permits / inspections / COIs
 * sit lower since the homeowner needs them rarely.
 */

import { FileText } from 'lucide-react';
import {
  DOCUMENT_TYPE_DISPLAY_ORDER,
  type DocumentType,
  documentTypeLabels,
} from '@/lib/validators/project-document';

export type PortalDocument = {
  id: string;
  type: DocumentType;
  title: string;
  url: string;
  bytes: number | null;
  expires_at: string | null;
};

function humanBytes(n: number | null): string {
  if (!n || n <= 0) return '';
  const k = 1024;
  if (n < k) return `${n} B`;
  if (n < k * k) return `${(n / k).toFixed(1)} KB`;
  return `${(n / k / k).toFixed(1)} MB`;
}

export function PortalDocuments({
  documents,
  timezone,
}: {
  documents: PortalDocument[];
  timezone: string;
}) {
  if (documents.length === 0) return null;

  const buckets = new Map<DocumentType, PortalDocument[]>();
  for (const doc of documents) {
    const list = buckets.get(doc.type) ?? [];
    list.push(doc);
    buckets.set(doc.type, list);
  }
  const orderedTypes = DOCUMENT_TYPE_DISPLAY_ORDER.filter((t) => (buckets.get(t)?.length ?? 0) > 0);

  return (
    <section className="space-y-4" aria-labelledby="documents-heading">
      <div>
        <h2 id="documents-heading" className="text-base font-semibold">
          Documents &amp; warranties
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Permanent files for your home — keep them somewhere safe. They&rsquo;ll all be in your
          final Home Record at the end of the job too.
        </p>
      </div>

      {orderedTypes.map((type) => {
        const docs = buckets.get(type) ?? [];
        return (
          <div key={type} className="rounded-lg border bg-card">
            <h3 className="border-b px-4 py-2 text-sm font-semibold">
              {documentTypeLabels[type]}
              <span className="ml-2 text-xs font-normal text-muted-foreground">{docs.length}</span>
            </h3>
            <ul className="divide-y">
              {docs.map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-4 py-3">
                  <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <a
                      href={d.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-sm font-medium hover:underline"
                      title={d.title}
                    >
                      {d.title}
                    </a>
                    <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                      {humanBytes(d.bytes) ? <span>{humanBytes(d.bytes)}</span> : null}
                      {d.expires_at ? (
                        <span>
                          Expires{' '}
                          {new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(
                            new Date(d.expires_at),
                          )}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
