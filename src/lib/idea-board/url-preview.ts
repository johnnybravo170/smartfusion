/**
 * Server-side URL preview fetcher for the customer idea board.
 *
 * Two branches:
 *   1. Pinterest URLs (pinterest.com/pin/..., pin.it/...) → call the
 *      stable Pinterest oEmbed endpoint for thumbnail + title.
 *   2. Other URLs → fetch the HTML and parse `<meta property="og:image">`
 *      / `<meta property="og:title">` / `<title>` out of the head.
 *
 * Defensive against SSRF and slow targets:
 *   - Reject non-http(s) schemes.
 *   - Resolve the hostname; reject loopback / link-local / private-IP
 *     destinations so the portal can't be used to scan our internal
 *     network.
 *   - 5s connect + 5s body timeouts via AbortController.
 *   - Cap the body read at 1MB so a malicious giant page can't OOM us.
 *
 * Preview is best-effort. Callers save the row regardless; a missing
 * thumbnail/title is fine.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type UrlPreview = {
  thumbnail_url: string | null;
  title: string | null;
};

const FETCH_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 1_000_000;

const PINTEREST_HOST_RE = /(^|\.)pinterest\.[a-z.]+$|(^|\.)pin\.it$/i;

export async function fetchUrlPreview(
  rawUrl: string,
): Promise<{ ok: true; preview: UrlPreview } | { ok: false; error: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Invalid URL.' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http(s) URLs are supported.' };
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostname || isUnsafeHostname(hostname)) {
    return { ok: false, error: 'URL hostname is not allowed.' };
  }
  if (!(await isResolvableToPublicAddress(hostname))) {
    return { ok: false, error: 'URL points at a private network.' };
  }

  if (PINTEREST_HOST_RE.test(hostname)) {
    const pin = await fetchPinterestOembed(rawUrl);
    if (pin.ok) return { ok: true, preview: pin.preview };
    // Fall through to og:image scrape if oEmbed misses.
  }

  return fetchOpenGraphPreview(url);
}

function isUnsafeHostname(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  if (hostname.endsWith('.local')) return true;
  if (hostname.endsWith('.internal')) return true;
  // Bare IPs we can pre-screen before DNS resolution.
  const ipFamily = isIP(hostname);
  if (ipFamily === 4 && isPrivateIPv4(hostname)) return true;
  if (ipFamily === 6 && isPrivateIPv6(hostname)) return true;
  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + AWS metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  if (lower === '::') return true;
  if (lower.startsWith('fe80:')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
  return false;
}

async function isResolvableToPublicAddress(hostname: string): Promise<boolean> {
  // If it's already an IP literal, isUnsafeHostname has already vetted it.
  if (isIP(hostname)) return true;
  try {
    const records = await lookup(hostname, { all: true });
    if (records.length === 0) return false;
    for (const r of records) {
      if (r.family === 4 && isPrivateIPv4(r.address)) return false;
      if (r.family === 6 && isPrivateIPv6(r.address)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchPinterestOembed(
  pinUrl: string,
): Promise<{ ok: true; preview: UrlPreview } | { ok: false; error: string }> {
  const oembedUrl = `https://api.pinterest.com/oembed.json?url=${encodeURIComponent(pinUrl)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(oembedUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, error: `oEmbed ${res.status}` };
    const data = (await res.json()) as { thumbnail_url?: string; title?: string };
    return {
      ok: true,
      preview: {
        thumbnail_url: typeof data.thumbnail_url === 'string' ? data.thumbnail_url : null,
        title: typeof data.title === 'string' ? data.title : null,
      },
    };
  } catch {
    return { ok: false, error: 'oEmbed fetch failed.' };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOpenGraphPreview(
  url: URL,
): Promise<{ ok: true; preview: UrlPreview } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'HeyHenry-IdeaBoard/1.0 (+https://heyhenry.io)',
      },
    });
    if (!res.ok) return { ok: false, error: `${res.status}` };
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (ct && !ct.includes('text/html') && !ct.includes('application/xhtml')) {
      return { ok: true, preview: { thumbnail_url: null, title: null } };
    }
    const html = await readBodyCapped(res, MAX_BODY_BYTES);
    return { ok: true, preview: parseHeadMeta(html, url) };
  } catch {
    return { ok: false, error: 'fetch failed' };
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let out = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      out += decoder.decode(value.subarray(0, value.byteLength - (total - maxBytes)), {
        stream: false,
      });
      try {
        await reader.cancel();
      } catch {}
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function parseHeadMeta(html: string, baseUrl: URL): UrlPreview {
  // Truncate to <head> when possible — cheaper regex, fewer false matches.
  const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  const head = headMatch?.[1] ?? html.slice(0, 200_000);

  const ogImage = pickMeta(head, 'og:image') ?? pickMeta(head, 'twitter:image');
  const ogTitle = pickMeta(head, 'og:title') ?? pickMeta(head, 'twitter:title');
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;

  const thumbnail = ogImage ? safeAbsoluteUrl(ogImage, baseUrl) : null;
  const title = (ogTitle ?? titleTag ?? null)?.replace(/\s+/g, ' ').trim() || null;

  return { thumbnail_url: thumbnail, title };
}

function pickMeta(head: string, property: string): string | null {
  // Try property= first (Open Graph), then name= (Twitter / generic).
  const propRe = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escapeRegex(property)}["'][^>]*content=["']([^"']+)["']`,
    'i',
  );
  const reverseRe = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${escapeRegex(property)}["']`,
    'i',
  );
  return head.match(propRe)?.[1] ?? head.match(reverseRe)?.[1] ?? null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeAbsoluteUrl(candidate: string, base: URL): string | null {
  try {
    const u = new URL(candidate, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}
