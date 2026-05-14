/**
 * V1 /inbox/email is gone. Preserves bookmarks + the project-page banner's
 * legacy deep-link by 308-redirecting to /inbox/intake?source=email,
 * carrying over a ?project= filter when present.
 */

import { redirect } from 'next/navigation';

type RawSearchParams = Record<string, string | string[] | undefined>;

export default async function InboundEmailLegacyRedirect({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const params = new URLSearchParams({ source: 'email' });
  if (typeof sp.project === 'string' && sp.project) params.set('project', sp.project);
  redirect(`/inbox/intake?${params.toString()}`);
}
