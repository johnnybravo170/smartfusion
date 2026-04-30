'use client';

/**
 * Settings card for managing the operator's public quote link slug.
 *
 * Allows the operator to set a URL-friendly slug for their public
 * quoting widget at /q/{slug}.
 */

import { Copy, ExternalLink, Globe } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { updateTenantSlugAction } from '@/server/actions/settings';

type PublicQuoteLinkCardProps = {
  currentSlug: string | null;
  businessName: string;
};

function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

export function PublicQuoteLinkCard({ currentSlug, businessName }: PublicQuoteLinkCardProps) {
  const [slug, setSlug] = useState(currentSlug ?? suggestSlug(businessName));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const appUrl = typeof window !== 'undefined' ? window.location.origin : 'https://app.heyhenry.io';
  const fullUrl = `${appUrl}/q/${slug}`;

  function handleSave() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateTenantSlugAction(slug);
      if (result.ok) {
        setSaved(true);
        toast.success('Public quote link saved.');
      } else {
        setError(result.error ?? 'Failed to save.');
        toast.error(result.error ?? 'Failed to save.');
      }
    });
  }

  function handleCopy() {
    navigator.clipboard.writeText(fullUrl).then(() => {
      toast.success('Link copied to clipboard.');
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Globe className="size-5" />
          <div>
            <CardTitle>Public Quote Link</CardTitle>
            <CardDescription>
              Share this link with customers so they can get instant estimates.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <label htmlFor="slug-input" className="mb-1 block text-sm font-medium">
            Your URL slug
          </label>
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-sm text-muted-foreground">/q/</span>
            <Input
              id="slug-input"
              type="text"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
                setSaved(false);
                setError(null);
              }}
              placeholder="your-business-name"
              maxLength={50}
              className="flex-1"
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Lowercase letters, numbers, and hyphens only. 3-50 characters.
          </p>
        </div>

        {slug.length >= 3 && (
          <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm font-mono">{fullUrl}</span>
            <Button type="button" variant="ghost" size="sm" onClick={handleCopy}>
              <Copy className="size-3.5" />
            </Button>
            {currentSlug && (
              <a href={fullUrl} target="_blank" rel="noopener noreferrer">
                <Button type="button" variant="ghost" size="sm" asChild>
                  <span>
                    <ExternalLink className="size-3.5" />
                  </span>
                </Button>
              </a>
            )}
          </div>
        )}

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        {saved ? (
          <p className="text-sm text-green-600">Saved! Your public quote page is live.</p>
        ) : null}

        <Button type="button" onClick={handleSave} disabled={pending || slug.length < 3}>
          {pending ? 'Saving...' : 'Save'}
        </Button>
      </CardContent>
    </Card>
  );
}
