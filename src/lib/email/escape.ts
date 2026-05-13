/**
 * Email-rendering escape helpers. Every email template should interpolate
 * user-controllable input through one of these — never bare `${value}`
 * inside HTML.
 *
 * - `escapeHtml(s)`         → text content + double-quoted attribute values
 *                             (escapes &, <, >, ", ').
 * - `safeUrl(s)`            → `<a href>` / `<img src>` URLs. Validates the
 *                             URL parses and uses an http(s) scheme; returns
 *                             '#' for invalid/unsafe input (incl. `javascript:`).
 * - `safeMailtoHref(email)` → `<a href="mailto:...">`. Validates the email
 *                             has no HTML/URL metacharacters; returns '' on
 *                             reject so the caller can omit the link.
 * - `safeTelHref(phone)`    → `<a href="tel:...">`. Strips formatting down
 *                             to digits + leading '+'; returns '' on reject.
 *
 * All four return strings that are SAFE to drop directly into a
 * double-quoted HTML attribute. Text content uses `escapeHtml` only.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SAFE_URL_SCHEMES = new Set(['http:', 'https:']);

export function safeUrl(input: string | null | undefined): string {
  if (!input) return '#';
  try {
    const u = new URL(input);
    if (!SAFE_URL_SCHEMES.has(u.protocol)) return '#';
    return escapeHtml(u.toString());
  } catch {
    return '#';
  }
}

// Permissive but reject anything that could break out of a quoted attribute
// or smuggle a second URL/scheme into the href.
const EMAIL_SHAPE = /^[^\s"'<>`,;]+@[^\s"'<>`,;]+\.[^\s"'<>`,;]+$/;

export function safeMailtoHref(email: string | null | undefined): string {
  if (!email) return '';
  const trimmed = email.trim();
  if (!EMAIL_SHAPE.test(trimmed)) return '';
  return `mailto:${escapeHtml(trimmed)}`;
}

export function safeTelHref(phone: string | null | undefined): string {
  if (!phone) return '';
  // Keep only digits and a single leading '+'. Anything else (spaces, dashes,
  // parens, extensions) is stripped — tel: URIs are digits-and-plus only per
  // RFC 3966 for the reliable dial path. Display text stays formatted via
  // escapeHtml on the link label.
  const stripped = phone.replace(/[^\d+]/g, '');
  const normalized = stripped.startsWith('+')
    ? `+${stripped.slice(1).replace(/\+/g, '')}`
    : stripped.replace(/\+/g, '');
  if (!/^\+?\d{4,}$/.test(normalized)) return '';
  return `tel:${normalized}`;
}
