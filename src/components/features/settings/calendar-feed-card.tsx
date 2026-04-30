'use client';

import { CalendarDays, Check, Copy } from 'lucide-react';
import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type Props = {
  feedUrl: string;
};

export function CalendarFeedCard({ feedUrl }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(feedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const input = document.createElement('input');
      input.value = feedUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [feedUrl]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CalendarDays className="size-5" />
          <div className="flex-1">
            <CardTitle>Calendar</CardTitle>
            <CardDescription>
              Subscribe to your job calendar in Google Calendar, Apple Calendar, or Outlook.
            </CardDescription>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-muted px-3 py-2 text-xs">
            {feedUrl}
          </code>
          <Button variant="outline" size="sm" onClick={handleCopy}>
            {copied ? (
              <>
                <Check className="size-3.5" />
                Copied
              </>
            ) : (
              <>
                <Copy className="size-3.5" />
                Copy
              </>
            )}
          </Button>
        </div>

        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
          <p>
            <strong>Google Calendar:</strong> Settings &gt; Add calendar &gt; From URL &gt; paste
            the link above.
          </p>
          <p>
            <strong>Apple Calendar:</strong> File &gt; New Calendar Subscription &gt; paste the link
            above.
          </p>
          <p>
            <strong>Outlook:</strong> Add calendar &gt; Subscribe from web &gt; paste the link
            above.
          </p>
        </div>
      </CardHeader>
    </Card>
  );
}
