/**
 * Sanitization guard for `<RichTextDisplay>`.
 *
 * `react-markdown` strips raw HTML by default. The day someone enables
 * `rehype-raw` is the day stored XSS becomes possible — so this test asserts
 * that the rendered output of malicious markdown payloads contains no live
 * `<script>` tags, no inline event handlers, and no javascript: URLs.
 *
 * If you ever change `RichTextDisplay` to allow HTML pass-through, this test
 * MUST fail until you also add `rehype-sanitize` with a strict allowlist.
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RichTextDisplay } from '@/components/ui/rich-text-display';

function html(markdown: string) {
  const { container } = render(<RichTextDisplay markdown={markdown} />);
  return container.innerHTML;
}

function dom(markdown: string) {
  return render(<RichTextDisplay markdown={markdown} />).container;
}

/** True iff any DOM element has any event-handler-style attribute set. */
function hasLiveEventAttribute(container: HTMLElement): boolean {
  const all = container.querySelectorAll('*');
  for (const el of all) {
    for (const attr of el.attributes) {
      if (/^on/i.test(attr.name)) return true;
    }
  }
  return false;
}

describe('RichTextDisplay sanitization', () => {
  it('escapes raw <script> tags (rendered as text, not executed)', () => {
    const out = html('Hello <script>alert(1)</script> world');
    // No live <script> tag in the DOM.
    expect(out).not.toMatch(/<script\b/i);
    // The text appears, but escaped — `<` is now `&lt;`, so it's harmless text.
    expect(out).toContain('&lt;script&gt;');
  });

  it('escapes inline event handlers on an <img>', () => {
    const container = dom('<img src=x onerror="alert(1)" />');
    // No live <img> element rendered (we don't allow images).
    expect(container.querySelectorAll('img')).toHaveLength(0);
    // No live event-handler attribute on ANY element.
    expect(hasLiveEventAttribute(container)).toBe(false);
  });

  it('blocks javascript: links via the custom `a` renderer', () => {
    // Markdown link with a javascript: href — react-markdown passes the href
    // through to our custom <a> renderer. Browsers refuse to navigate
    // javascript: URLs that lack the protocol, but we want it stripped
    // before it ever hits the DOM.
    const out = html('[click me](javascript:alert(1))');
    // The text renders; the href must not be a javascript: URL.
    expect(out).toContain('click me');
    expect(out).not.toMatch(/href="javascript:/i);
  });

  it('renders allowed markdown syntax', () => {
    const out = html('**bold** *italic* `code`\n\n- one\n- two');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>italic</em>');
    expect(out).toContain('<code>code</code>');
    expect(out).toMatch(/<ul[^>]*>[\s\S]*<li[^>]*>one<\/li>[\s\S]*<li[^>]*>two<\/li>/);
  });

  it('renders nothing for empty / null markdown', () => {
    expect(html('')).toBe('');
    const { container } = render(<RichTextDisplay markdown={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('opens links in a new tab with safe rel', () => {
    const out = html('[homepage](https://example.com)');
    expect(out).toContain('target="_blank"');
    expect(out).toMatch(/rel="[^"]*noopener[^"]*"/);
    expect(out).toMatch(/rel="[^"]*noreferrer[^"]*"/);
  });
});
