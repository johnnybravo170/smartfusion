import { describe, expect, it } from 'vitest';
import { escapeHtml, safeMailtoHref, safeTelHref, safeUrl } from '@/lib/email/escape';

describe('escapeHtml', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('A & B')).toBe('A &amp; B');
    expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');
    expect(escapeHtml("'apostrophe'")).toBe('&#39;apostrophe&#39;');
  });

  it('escapes & first so existing entities double-encode (round-trip safe)', () => {
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });
});

describe('safeUrl', () => {
  it('passes through http(s) URLs', () => {
    expect(safeUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
    expect(safeUrl('http://example.com/')).toBe('http://example.com/');
  });

  it('rejects javascript: with #', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('#');
  });

  it('rejects data: and vbscript: with #', () => {
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBe('#');
    expect(safeUrl('vbscript:msgbox')).toBe('#');
  });

  it('rejects malformed URLs with #', () => {
    expect(safeUrl('not a url')).toBe('#');
    expect(safeUrl('')).toBe('#');
    expect(safeUrl(null)).toBe('#');
    expect(safeUrl(undefined)).toBe('#');
  });

  it('produces output safe to drop into a double-quoted href attribute', () => {
    // URL parses but contains " — either percent-encoded by URL or escaped to
    // &quot; downstream. Either way no bare " can survive.
    const out = safeUrl('https://example.com/?q="evil"');
    expect(out).not.toContain('"');
  });

  it('produces output free of < > characters', () => {
    const out = safeUrl('https://example.com/?q=<script>');
    expect(out).not.toMatch(/[<>]/);
  });
});

describe('safeMailtoHref', () => {
  it('returns mailto: for valid email shape', () => {
    expect(safeMailtoHref('user@example.com')).toBe('mailto:user@example.com');
    expect(safeMailtoHref(' user@example.com ')).toBe('mailto:user@example.com');
  });

  it('returns empty string for malformed emails', () => {
    expect(safeMailtoHref('not an email')).toBe('');
    expect(safeMailtoHref('user@')).toBe('');
    expect(safeMailtoHref('@example.com')).toBe('');
    expect(safeMailtoHref('')).toBe('');
    expect(safeMailtoHref(null)).toBe('');
  });

  it('rejects emails with HTML/URL metacharacters', () => {
    expect(safeMailtoHref('a@b.com"><script>alert(1)</script>')).toBe('');
    expect(safeMailtoHref("a@b.com' onclick='x")).toBe('');
    expect(safeMailtoHref('a@b.com,evil@c.com')).toBe('');
  });
});

describe('safeTelHref', () => {
  it('strips formatting to digits + leading plus', () => {
    expect(safeTelHref('(555) 123-4567')).toBe('tel:5551234567');
    expect(safeTelHref('+1 555-123-4567')).toBe('tel:+15551234567');
    expect(safeTelHref('+1 (555) 123-4567 ext 89')).toBe('tel:+1555123456789');
  });

  it('returns empty for non-numeric or too-short input', () => {
    expect(safeTelHref('not a phone')).toBe('');
    expect(safeTelHref('123')).toBe('');
    expect(safeTelHref('')).toBe('');
    expect(safeTelHref(null)).toBe('');
  });

  it('strips HTML/URL metacharacters from input before emitting', () => {
    // Non-digit chars (including " < > ' ) are dropped by the regex strip
    // pass, so the output is digits + optional leading + only.
    const out = safeTelHref('555-1234"><script>5678');
    expect(out).not.toMatch(/[<>"'`]/);
  });
});
