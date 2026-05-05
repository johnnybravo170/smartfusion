'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Markdown renderer scoped to board content. Handles GitHub-flavored
 * markdown (tables, strikethrough, task lists). Tailwind classes target
 * the rendered HTML; we keep the prose visually compact since these
 * messages are read inline alongside transcript metadata, not as long
 * articles.
 *
 * No raw-HTML support on purpose — these strings come from the LLM and
 * we don't want it injecting markup the user can't see in source view.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="board-md text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => <h1 className="mt-3 text-base font-semibold" {...props} />,
          h2: (props) => <h2 className="mt-3 text-base font-semibold" {...props} />,
          h3: (props) => <h3 className="mt-2 text-sm font-semibold" {...props} />,
          h4: (props) => <h4 className="mt-2 text-sm font-medium" {...props} />,
          p: (props) => <p className="my-2" {...props} />,
          ul: (props) => <ul className="my-2 list-disc pl-5" {...props} />,
          ol: (props) => <ol className="my-2 list-decimal pl-5" {...props} />,
          li: (props) => <li className="my-0.5" {...props} />,
          strong: (props) => <strong className="font-semibold" {...props} />,
          em: (props) => <em className="italic" {...props} />,
          code: ({ className, children: codeChildren, ...rest }) => {
            const isBlock = className?.includes('language-');
            if (isBlock) {
              return (
                <code
                  className={`block whitespace-pre-wrap rounded bg-[var(--muted)] p-2 text-xs ${className ?? ''}`}
                  {...rest}
                >
                  {codeChildren}
                </code>
              );
            }
            return (
              <code className="rounded bg-[var(--muted)] px-1 py-0.5 text-xs" {...rest}>
                {codeChildren}
              </code>
            );
          },
          pre: (props) => <pre className="my-2 overflow-x-auto" {...props} />,
          blockquote: (props) => (
            <blockquote
              className="my-2 border-l-2 border-[var(--border)] pl-3 text-[var(--muted-foreground)]"
              {...props}
            />
          ),
          hr: (props) => <hr className="my-3 border-[var(--border)]" {...props} />,
          a: (props) => (
            <a
              className="text-sky-600 underline hover:text-sky-700 dark:text-sky-400"
              target="_blank"
              rel="noreferrer"
              {...props}
            />
          ),
          table: (props) => (
            <div className="my-2 overflow-x-auto">
              <table className="min-w-full border-collapse text-xs" {...props} />
            </div>
          ),
          th: (props) => (
            <th
              className="border-b border-[var(--border)] px-2 py-1 text-left font-medium"
              {...props}
            />
          ),
          td: (props) => <td className="border-b border-[var(--border)] px-2 py-1" {...props} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
