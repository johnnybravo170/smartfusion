/**
 * Convert one of our email templates' HTML body into a plain-text
 * alternative for Resend's `text:` field. Modern spam filters
 * (Gmail/Outlook in particular) downweight HTML-only emails because
 * legitimate senders typically include both parts.
 *
 * Templates in this codebase are simple — system-font HTML with
 * paragraphs, anchors, and a single CTA button — so a purpose-built
 * stripper does the job without pulling in a 50kb dependency. If we
 * ever start sending tables, lists, or nested layouts, swap this for
 * `html-to-text`.
 */
export function htmlToPlainText(html: string): string {
  return (
    html
      // Pull anchors → "label (url)" so URLs survive in plain text.
      .replace(
        /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (_m, url, label) => `${label.trim()} (${url})`,
      )
      // Block-level boundaries become newlines.
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote)>/gi, '\n')
      // Strip the rest.
      .replace(/<[^>]+>/g, '')
      // HTML entities that show up in our templates.
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&mdash;/g, '—')
      .replace(/&ndash;/g, '–')
      // Numeric entities (covers the rest).
      .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
      // Collapse whitespace runs but preserve paragraph breaks.
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
