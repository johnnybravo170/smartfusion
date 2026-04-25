/**
 * Permanent Home Record share page. Slice 6a of the Customer Portal &
 * Home Record build.
 *
 * Reads the frozen JSONB snapshot from `home_records` keyed on slug and
 * renders the full handoff document — header / phases / decisions /
 * change orders / selections / photos / documents. Server component
 * end-to-end (no JS) — homeowners, spouses, realtors, insurers,
 * future contractors all just open the link.
 *
 * Storage paths in the snapshot are re-signed via the admin client at
 * render time. Signed URLs only live ~1 week, so we re-sign on every
 * request. The snapshot itself is permanent; only the rendering is
 * dynamic.
 */

import { FileText } from 'lucide-react';
import { notFound } from 'next/navigation';
import { PublicViewLogger } from '@/components/features/public/public-view-logger';
import type { HomeRecordSnapshotV1 } from '@/lib/db/queries/home-records';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  PORTAL_PHOTO_TAG_DISPLAY_ORDER,
  type PortalPhotoTag,
  portalPhotoTagLabels,
} from '@/lib/validators/portal-photo';
import {
  DOCUMENT_TYPE_DISPLAY_ORDER,
  type DocumentType,
  documentTypeLabels,
} from '@/lib/validators/project-document';
import {
  type SelectionCategory,
  selectionCategoryLabels,
} from '@/lib/validators/project-selection';

export const metadata = {
  title: 'Home Record — HeyHenry',
};

const cadFormat = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-CA', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export default async function HomeRecordPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const admin = createAdminClient();

  const { data: record } = await admin
    .from('home_records')
    .select('snapshot, generated_at, project_id, pdf_path')
    .eq('slug', slug)
    .single();
  if (!record) notFound();

  const snapshot = (record as Record<string, unknown>).snapshot as HomeRecordSnapshotV1;
  const hasPdf = Boolean((record as Record<string, unknown>).pdf_path);

  // Re-sign all storage paths in one batch (separate buckets, so two
  // calls — photos + project-docs).
  const photoPaths = snapshot.photos.map((p) => p.storage_path);
  const docPaths = snapshot.documents.map((d) => d.storage_path);

  const photoUrlMap = new Map<string, string>();
  if (photoPaths.length > 0) {
    const { data: signed } = await admin.storage.from('photos').createSignedUrls(photoPaths, 3600);
    for (const row of signed ?? []) {
      if (row.path && row.signedUrl) photoUrlMap.set(row.path, row.signedUrl);
    }
  }
  const docUrlMap = new Map<string, string>();
  if (docPaths.length > 0) {
    const { data: signed } = await admin.storage
      .from('project-docs')
      .createSignedUrls(docPaths, 3600);
    for (const row of signed ?? []) {
      if (row.path && row.signedUrl) docUrlMap.set(row.path, row.signedUrl);
    }
  }

  // Group photos by tag for sectioned rendering.
  const photoBuckets = new Map<PortalPhotoTag, typeof snapshot.photos>();
  for (const photo of snapshot.photos) {
    for (const tag of photo.portal_tags) {
      const list = photoBuckets.get(tag) ?? [];
      list.push(photo);
      photoBuckets.set(tag, list);
    }
  }

  // Group documents by type.
  const docBuckets = new Map<DocumentType, typeof snapshot.documents>();
  for (const doc of snapshot.documents) {
    const list = docBuckets.get(doc.type) ?? [];
    list.push(doc);
    docBuckets.set(doc.type, list);
  }

  // Group selections by room.
  const selectionsByRoom = new Map<string, typeof snapshot.selections>();
  for (const sel of snapshot.selections) {
    const room = sel.room.trim() || 'Unsorted';
    const list = selectionsByRoom.get(room) ?? [];
    list.push(sel);
    selectionsByRoom.set(room, list);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <PublicViewLogger resourceType="home-record" identifier={slug} />

      {/* Header */}
      <header className="mb-10 text-center">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Home Record
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{snapshot.project.name}</h1>
        {snapshot.customer.name ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {snapshot.customer.name}
            {snapshot.customer.address ? ` — ${snapshot.customer.address}` : null}
          </p>
        ) : null}
        <p className="mt-3 text-xs text-muted-foreground">
          Prepared by {snapshot.contractor.name} • Generated {formatDate(snapshot.generated_at)}
        </p>
        {hasPdf ? (
          <a
            href={`/home-record/${slug}/download`}
            className="mt-4 inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Download PDF
          </a>
        ) : null}
      </header>

      {/* Project summary */}
      {snapshot.project.description ? (
        <Section title="Project summary">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {snapshot.project.description}
          </p>
          <DateRow start={snapshot.project.start_date} end={snapshot.project.target_end_date} />
        </Section>
      ) : null}

      {/* Phases */}
      {snapshot.phases.length > 0 ? (
        <Section title="Project phases">
          <ol className="space-y-1.5">
            {snapshot.phases.map((phase) => (
              <li
                key={phase.name}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border bg-card px-3 py-2 text-sm"
              >
                <span className="font-medium">{phase.name}</span>
                <span className="text-xs text-muted-foreground">
                  {phase.status === 'complete'
                    ? `Completed ${formatDate(phase.completed_at)}`
                    : phase.status === 'in_progress'
                      ? phase.started_at
                        ? `Started ${formatDate(phase.started_at)}`
                        : 'In progress'
                      : 'Upcoming'}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      {/* Selections — grouped by room */}
      {selectionsByRoom.size > 0 ? (
        <Section title="What we used in your home">
          <div className="space-y-4">
            {Array.from(selectionsByRoom.entries()).map(([room, items]) => (
              <div key={room} className="rounded-lg border bg-card">
                <h3 className="border-b px-4 py-2 text-sm font-semibold">{room}</h3>
                <ul className="divide-y">
                  {items.map((sel) => {
                    const headline = [sel.brand, sel.name].filter(Boolean).join(' ');
                    const detail = [sel.code, sel.finish].filter(Boolean).join(' • ');
                    return (
                      <li
                        key={`${sel.room}-${sel.category}-${sel.name}-${sel.code}`}
                        className="px-4 py-3"
                      >
                        <div className="flex flex-wrap items-baseline gap-2">
                          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium">
                            {selectionCategoryLabels[sel.category as SelectionCategory] ??
                              sel.category}
                          </span>
                          {headline ? (
                            <span className="text-sm font-medium">{headline}</span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                          {detail ? <span>{detail}</span> : null}
                          {sel.supplier ? <span>{sel.supplier}</span> : null}
                          {sel.sku ? <span>SKU {sel.sku}</span> : null}
                          {sel.warranty_url ? (
                            <a
                              href={sel.warranty_url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary hover:underline"
                            >
                              Warranty info
                            </a>
                          ) : null}
                        </div>
                        {sel.notes ? (
                          <p className="mt-1 text-xs text-muted-foreground">{sel.notes}</p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {/* Photos — by category, including behind-the-wall as its own section */}
      {snapshot.photos.length > 0 ? (
        <Section title="Photos">
          <div className="space-y-6">
            {PORTAL_PHOTO_TAG_DISPLAY_ORDER.map((tag) => {
              const bucket = photoBuckets.get(tag) ?? [];
              if (bucket.length === 0) return null;
              return (
                <div key={tag}>
                  <h3 className="mb-2 text-sm font-semibold">
                    {portalPhotoTagLabels[tag]}
                    {tag === 'behind_wall' ? (
                      <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                        Useful for future repairs and resale
                      </span>
                    ) : null}
                  </h3>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                    {bucket.map((photo) => {
                      const url = photoUrlMap.get(photo.storage_path);
                      if (!url) return null;
                      return (
                        // biome-ignore lint/performance/noImgElement: signed URLs bypass next/image
                        <img
                          key={`${tag}-${photo.id}`}
                          src={url}
                          alt={photo.caption ?? portalPhotoTagLabels[tag]}
                          loading="lazy"
                          className="aspect-square w-full rounded-md border object-cover"
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </Section>
      ) : null}

      {/* Decisions */}
      {snapshot.decisions.length > 0 ? (
        <Section title="Decisions">
          <ul className="space-y-2">
            {snapshot.decisions.map((d) => (
              <li
                key={`${d.label}-${d.decided_at ?? ''}`}
                className="rounded-md border bg-card px-3 py-2"
              >
                <p className="text-sm font-medium">{d.label}</p>
                {d.description ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">{d.description}</p>
                ) : null}
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {d.decided_value === 'approved' ? 'Approved' : 'Declined'}
                  {d.decided_by_customer ? ` by ${d.decided_by_customer}` : ''} on{' '}
                  {formatDate(d.decided_at)}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/* Change orders */}
      {snapshot.change_orders.length > 0 ? (
        <Section title="Change orders">
          <ul className="space-y-2">
            {snapshot.change_orders.map((co) => (
              <li
                key={`${co.title}-${co.approved_at ?? ''}`}
                className="rounded-md border bg-card p-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium">{co.title}</p>
                  <span className="text-sm tabular-nums">
                    {cadFormat.format((co.cost_impact_cents ?? 0) / 100)}
                  </span>
                </div>
                {co.description ? (
                  <p className="mt-1 text-xs text-muted-foreground">{co.description}</p>
                ) : null}
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Approved
                  {co.approved_by_name ? ` by ${co.approved_by_name}` : ''}
                  {co.approved_at ? ` on ${formatDate(co.approved_at)}` : ''}
                  {co.timeline_impact_days ? ` • +${co.timeline_impact_days} days` : ''}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/* Documents — grouped by type */}
      {snapshot.documents.length > 0 ? (
        <Section title="Documents & warranties">
          <div className="space-y-4">
            {DOCUMENT_TYPE_DISPLAY_ORDER.map((type) => {
              const docs = docBuckets.get(type) ?? [];
              if (docs.length === 0) return null;
              return (
                <div key={type} className="rounded-lg border bg-card">
                  <h3 className="border-b px-4 py-2 text-sm font-semibold">
                    {documentTypeLabels[type]}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {docs.length}
                    </span>
                  </h3>
                  <ul className="divide-y">
                    {docs.map((d) => {
                      const url = docUrlMap.get(d.storage_path);
                      return (
                        <li key={d.storage_path} className="flex items-center gap-3 px-4 py-3">
                          <FileText className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                          <div className="min-w-0 flex-1">
                            {url ? (
                              <a
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                className="block truncate text-sm font-medium hover:underline"
                              >
                                {d.title}
                              </a>
                            ) : (
                              <span className="block truncate text-sm font-medium">{d.title}</span>
                            )}
                            {d.expires_at ? (
                              <p className="text-xs text-muted-foreground">
                                Expires {formatDate(d.expires_at)}
                              </p>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </Section>
      ) : null}

      <footer className="mt-12 border-t pt-6 text-center text-xs text-muted-foreground">
        <p>
          A permanent record from {snapshot.contractor.name}. Save this link — it works forever.
        </p>
      </footer>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function DateRow({ start, end }: { start: string | null; end: string | null }) {
  if (!start && !end) return null;
  return (
    <p className="mt-2 text-xs text-muted-foreground">
      {start ? `Started ${formatDate(start)}` : ''}
      {start && end ? ' • ' : ''}
      {end ? `Target ${formatDate(end)}` : ''}
    </p>
  );
}
