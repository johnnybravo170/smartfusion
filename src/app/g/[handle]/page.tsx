/**
 * Public photo gallery — landing page for every closeout share link.
 *
 * URL shape: `/g/{slug}-{token}` (slug optional; token is the access key).
 * No auth; token is the control. If the visited slug doesn't match the
 * canonical one stored with the link, we 302 to the right URL.
 *
 * Phase 3 scope: job-full galleries only. Other scope_types (album,
 * pair_set, single) fall through to 404.
 */

import { ImageOff, Star } from 'lucide-react';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { loadGalleryForJob } from '@/lib/photos/gallery-query';
import { lookupShareLink, parseShareHandle, recordShareLinkView } from '@/lib/photos/share-links';
import { toAbsoluteUrl } from '@/lib/validators/profile';

export const dynamic = 'force-dynamic';

const TAG_LABEL: Record<string, string> = {
  before: 'Before',
  after: 'After',
  progress: 'Progress',
  damage: 'Noted',
  other: 'Other',
};

const SOCIAL_LABELS: Record<string, string> = {
  googleBusiness: 'Google',
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  x: 'X',
};

export default async function PublicGalleryPage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const { slug: visitedSlug, token } = parseShareHandle(handle);

  const link = await lookupShareLink(token);
  if (!link) notFound();

  if (link.slug && link.slug !== visitedSlug) {
    redirect(`/g/${link.slug}-${link.token}`);
  }

  if (link.scopeType !== 'job_full') notFound();

  const reqHeaders = await headers();
  const clientIp =
    reqHeaders.get('x-forwarded-for')?.split(',')[0]?.trim() ?? reqHeaders.get('x-real-ip') ?? null;
  void recordShareLinkView(token, clientIp);

  const data = await loadGalleryForJob({ tenantId: link.tenantId, jobId: link.scopeId });
  if (!data) notFound();

  const groups = groupByTag(data.photos);
  const orderedTags: Array<keyof typeof TAG_LABEL> = [
    'before',
    'after',
    'progress',
    'damage',
    'other',
  ];

  const reviewUrl = toAbsoluteUrl(data.reviewUrl);
  const websiteUrl = toAbsoluteUrl(data.websiteUrl);
  const socialLinks = Object.entries(data.socials ?? {})
    .map(([key, value]) => ({
      key,
      label: SOCIAL_LABELS[key] ?? key,
      url: toAbsoluteUrl(value as string | null),
    }))
    .filter((s): s is { key: string; label: string; url: string } => Boolean(s.url));

  return (
    <main className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-5xl items-start gap-4 px-6 py-5">
          {data.logoUrl ? (
            // biome-ignore lint/performance/noImgElement: signed URL
            <img
              src={data.logoUrl}
              alt={data.tenantName}
              className="h-12 w-auto max-w-[160px] shrink-0 object-contain"
            />
          ) : null}
          <div className="flex-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
              Job gallery
            </p>
            <h1 className="mt-1 text-2xl font-semibold">
              {data.jobLabel ? `${data.jobLabel} · ${data.tenantName}` : data.tenantName}
            </h1>
            <p className="mt-1 text-sm text-neutral-500">
              Every photo is timestamped and kept on file by {data.tenantName}.
            </p>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-8">
        {data.photos.length === 0 ? (
          <div className="rounded-xl border bg-white p-12 text-center text-neutral-500">
            Photos will appear here as they're captured on the job.
          </div>
        ) : (
          <div className="flex flex-col gap-10">
            {orderedTags.map((tag) => {
              const items = groups.get(tag);
              if (!items || items.length === 0) return null;
              return (
                <section key={tag}>
                  <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-neutral-500">
                    {TAG_LABEL[tag]}
                  </h2>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {items.map((photo) => (
                      <figure key={photo.id} className="overflow-hidden rounded-xl border bg-white">
                        <div className="aspect-square w-full bg-neutral-100">
                          {photo.url ? (
                            // biome-ignore lint/performance/noImgElement: signed URLs bypass next/image optimizer
                            <img
                              src={photo.url}
                              alt={photo.caption ?? TAG_LABEL[tag] ?? 'Photo'}
                              loading="lazy"
                              className="size-full object-cover"
                            />
                          ) : (
                            <div className="flex size-full items-center justify-center text-neutral-400">
                              <ImageOff className="size-6" aria-hidden />
                            </div>
                          )}
                        </div>
                        {photo.caption ? (
                          <figcaption className="border-t px-3 py-2 text-xs text-neutral-600">
                            {photo.caption}
                          </figcaption>
                        ) : null}
                      </figure>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>

      {reviewUrl ? (
        <section id="review" className="mx-auto max-w-5xl px-6 pb-8">
          <a
            href={reviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-xl border bg-white px-6 py-4 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50"
          >
            <Star className="size-4 text-amber-500" aria-hidden />
            Leave {data.tenantName} a review
          </a>
        </section>
      ) : null}

      <footer className="mx-auto max-w-5xl px-6 pb-12 pt-4 text-center text-xs text-neutral-500">
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
          {websiteUrl ? (
            <a
              href={websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-neutral-700"
            >
              {stripScheme(websiteUrl)}
            </a>
          ) : null}
          {socialLinks.map((s) => (
            <a
              key={s.key}
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-neutral-700"
            >
              {s.label}
            </a>
          ))}
        </div>
        <p className="mt-3">Shared by {data.tenantName} via Hey Henry</p>
      </footer>
    </main>
  );
}

function groupByTag<T extends { tag: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const arr = map.get(item.tag) ?? [];
    arr.push(item);
    map.set(item.tag, arr);
  }
  return map;
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
