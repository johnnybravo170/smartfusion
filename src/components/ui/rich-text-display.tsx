/**
 * Render a markdown string with safe defaults.
 *
 * `react-markdown` does not render raw HTML by default — `<script>` / `<img
 * onerror>` / etc. are escaped to plain text. We don't enable the
 * `rehype-raw` / `rehypeRaw` plugin, which is what would open the XSS
 * door. See tests/unit/rich-text-sanitization.test.ts for the
 * regression guard.
 *
 * Supported syntax (intentionally limited):
 *   **bold** *italic* `inline code`
 *   - bullet list
 *   1. numbered list
 *   ### heading 3
 *   #### heading 4
 *   > blockquote
 *   [link](url)
 *
 * Not supported: images, tables, raw HTML, code blocks (single-line `inline`
 * code only). Keep the surface narrow until a real need surfaces.
 */

import ReactMarkdown from 'react-markdown';
import { cn } from '@/lib/utils';

type Props = {
  /** Markdown text. Null/empty renders nothing (caller decides the fallback). */
  markdown: string | null | undefined;
  /** Extra classes for the wrapper. */
  className?: string;
};

export function RichTextDisplay({ markdown, className }: Props) {
  if (!markdown || markdown.trim() === '') return null;
  return (
    <div
      className={cn(
        // Prose-ish styling without pulling in @tailwindcss/typography.
        'text-sm leading-relaxed',
        '[&_p]:mb-2 [&_p:last-child]:mb-0',
        '[&_strong]:font-semibold',
        '[&_em]:italic',
        '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs',
        '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5',
        '[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_li]:mb-1 [&_li:last-child]:mb-0',
        '[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold',
        '[&_h4]:mt-2 [&_h4]:mb-1 [&_h4]:text-sm [&_h4]:font-semibold',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-muted [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
        '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
        className,
      )}
    >
      <ReactMarkdown
        // Default `skipHtml: false` means raw <tags> get escaped, not rendered.
        // We DO NOT enable rehypeRaw — that would render arbitrary HTML.
        components={{
          // Force links to open in new tabs + add rel for safety.
          a: ({ href, children, ...rest }) => (
            <a {...rest} href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
