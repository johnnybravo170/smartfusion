/**
 * Variant-matrix coverage for renderEmailShell.
 *
 * Brief asked the test to live at src/lib/email/layout.test.ts, but vitest.config.ts
 * only includes tests/unit/** and tests/integration/**, so the test sits here.
 *
 * Matrix: callout variant (none / note / note-with-label / quote / warning)
 *   × CTA (none / primary / secondary)
 *   × signoff (present / absent)
 *   × branding logo (present / absent)
 */

import { describe, expect, it } from 'vitest';
import { renderCalloutHtml, renderCtaHtml, renderEmailShell } from '@/lib/email/layout';

describe('renderEmailShell', () => {
  const base = {
    heading: 'Welcome',
    body: '<p>Hello world.</p>',
    footerKey: 'portal_invite' as const,
  };

  it('renders the minimal shell with only heading + body + footer', () => {
    const html = renderEmailShell(base);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html>');
    expect(html).toContain('font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif');
    expect(html).toContain('max-width: 600px');
    expect(html).toContain('padding: 24px');
    expect(html).toContain('line-height: 1.5');
    expect(html).toContain('<h2 style="color: #0a0a0a;');
    expect(html).toContain('>Welcome<');
    expect(html).toContain('<p>Hello world.</p>');
    expect(html).toContain('Sent via HeyHenry');
    expect(html).toContain('utm_content=portal_invite');
    expect(html).toContain('<hr style="border: none; border-top: 1px solid #eee');
  });

  it('escapes heading text', () => {
    const html = renderEmailShell({ ...base, heading: 'Q & A <script>' });
    expect(html).toContain('Q &amp; A &lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('omits the logo block when brandingLogoHtml is missing', () => {
    const html = renderEmailShell(base);
    expect(html).not.toContain('<img');
  });

  it('renders the logo block when brandingLogoHtml is provided', () => {
    const logo = '<img src="x.png" alt="Acme" />';
    const html = renderEmailShell({ ...base, brandingLogoHtml: logo });
    expect(html).toContain(logo);
    // Logo comes before heading.
    expect(html.indexOf(logo)).toBeLessThan(html.indexOf('<h2'));
  });

  describe('callout variants', () => {
    it('renders a default note callout (no label)', () => {
      const html = renderEmailShell({
        ...base,
        callout: { contentHtml: 'Plain note.' },
      });
      expect(html).toContain('background: #f8fafc');
      expect(html).toContain('border-left: 3px solid #0a0a0a');
      expect(html).toContain('Plain note.');
      expect(html).not.toContain('white-space: pre-wrap');
    });

    it('renders a labeled note callout with two-paragraph shape', () => {
      const html = renderEmailShell({
        ...base,
        callout: { variant: 'note', label: 'Subject of your forward', contentHtml: 'Re: invoice' },
      });
      expect(html).toContain('Subject of your forward');
      expect(html).toContain('Re: invoice');
      expect(html).toContain('margin: 4px 0 0;');
    });

    it("renders a 'quote' callout with pre-wrap so operator line breaks survive", () => {
      const html = renderEmailShell({
        ...base,
        callout: { variant: 'quote', contentHtml: 'Line one\nLine two' },
      });
      expect(html).toContain('white-space: pre-wrap');
      expect(html).toContain('Line one\nLine two');
    });

    it("renders a 'warning' callout with amber tokens", () => {
      const html = renderEmailShell({
        ...base,
        callout: { variant: 'warning', contentHtml: 'Heads up.' },
      });
      expect(html).toContain('background: #fff7ed');
      expect(html).toContain('border-left: 3px solid #f59e0b');
    });

    it('escapes the callout label', () => {
      const html = renderEmailShell({
        ...base,
        callout: { label: '<bad>', contentHtml: 'ok' },
      });
      expect(html).toContain('&lt;bad&gt;');
      expect(html).not.toContain('<bad>');
    });
  });

  describe('CTA variants', () => {
    it('renders a primary CTA by default', () => {
      const html = renderEmailShell({
        ...base,
        cta: { label: 'View Project', href: 'https://example.com/p/123' },
      });
      expect(html).toContain('background: #0a0a0a');
      expect(html).toContain('color: white');
      expect(html).toContain('href="https://example.com/p/123"');
      expect(html).toContain('>View Project<');
    });

    it('renders a secondary CTA as an outlined button', () => {
      const html = renderEmailShell({
        ...base,
        cta: { variant: 'secondary', label: 'Maybe later', href: 'https://example.com/' },
      });
      expect(html).toContain('background: white');
      expect(html).toContain('border: 1px solid #0a0a0a');
    });

    it('omits the CTA block when not provided', () => {
      const html = renderEmailShell(base);
      expect(html).not.toContain('display: inline-block; padding: 12px 24px');
    });

    it('escapes the CTA label and href', () => {
      const html = renderEmailShell({
        ...base,
        cta: { label: 'A & B', href: 'https://example.com/?q="x"' },
      });
      expect(html).toContain('A &amp; B');
      expect(html).toContain('?q=&quot;x&quot;');
    });
  });

  describe('signoff', () => {
    it('renders the signoff when present', () => {
      const html = renderEmailShell({ ...base, signoff: '— Henry' });
      expect(html).toContain('color: #444');
      expect(html).toContain('— Henry');
    });

    it('omits the signoff when absent', () => {
      const html = renderEmailShell(base);
      expect(html).not.toContain('color: #444');
    });

    it('escapes the signoff text', () => {
      const html = renderEmailShell({ ...base, signoff: '<x>' });
      expect(html).toContain('&lt;x&gt;');
    });
  });

  describe('section order', () => {
    it('renders logo → heading → body → callout → cta → signoff → hr → footer', () => {
      const html = renderEmailShell({
        heading: 'Heading',
        body: '<p>BODY_MARKER</p>',
        callout: { contentHtml: 'CALLOUT_MARKER' },
        cta: { label: 'CTA_MARKER', href: 'https://example.com/' },
        signoff: 'SIGNOFF_MARKER',
        brandingLogoHtml: '<img alt="LOGO_MARKER" />',
        footerKey: 'portal_invite',
      });
      const order = [
        'LOGO_MARKER',
        'Heading',
        'BODY_MARKER',
        'CALLOUT_MARKER',
        'CTA_MARKER',
        'SIGNOFF_MARKER',
        '<hr',
        'Sent via HeyHenry',
      ].map((needle) => html.indexOf(needle));
      for (let i = 1; i < order.length; i++) {
        expect(order[i]).toBeGreaterThan(order[i - 1]);
      }
    });
  });
});

describe('renderCalloutHtml', () => {
  it('is exported for inline use mid-body', () => {
    const html = renderCalloutHtml({ contentHtml: 'hi' });
    expect(html).toContain('<div style="margin: 20px 0;');
  });
});

describe('renderCtaHtml', () => {
  it('is exported for inline use mid-body', () => {
    const html = renderCtaHtml({ label: 'Go', href: 'https://example.com/' });
    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain('>Go<');
  });
});
