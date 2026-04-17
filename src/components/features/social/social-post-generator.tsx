/**
 * Social post generator — client component.
 *
 * "Generate Social Post" button on completed jobs with before/after photos.
 * Calls the /api/social-post route, shows platform toggle (Instagram/Facebook),
 * and renders the preview card.
 */

'use client';

import { Sparkles } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import type { SocialPostResponse } from '@/app/api/social-post/route';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SocialPostPreview } from './social-post-preview';

type Platform = 'instagram' | 'facebook';

type SocialPostGeneratorProps = {
  jobId: string;
  businessName: string;
};

export function SocialPostGenerator({ jobId, businessName }: SocialPostGeneratorProps) {
  const [platform, setPlatform] = useState<Platform>('instagram');
  const [post, setPost] = useState<SocialPostResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasGenerated, setHasGenerated] = useState(false);

  const generate = useCallback(
    async (targetPlatform: Platform) => {
      setLoading(true);
      try {
        const res = await fetch('/api/social-post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId, platform: targetPlatform }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to generate post');
        }

        const data: SocialPostResponse = await res.json();
        setPost(data);
        setHasGenerated(true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Something went wrong';
        toast.error(msg);
      } finally {
        setLoading(false);
      }
    },
    [jobId],
  );

  const handlePlatformChange = useCallback(
    (value: string) => {
      const p = value as Platform;
      setPlatform(p);
      // Auto-regenerate when switching platforms if we already have a post
      if (hasGenerated) {
        generate(p);
      }
    },
    [generate, hasGenerated],
  );

  return (
    <section className="rounded-xl border bg-card p-5">
      <header className="flex items-center justify-between pb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Social Post
          </h2>
        </div>
        {!hasGenerated && (
          <Button size="sm" onClick={() => generate(platform)} disabled={loading}>
            <Sparkles className="size-3.5" />
            {loading ? 'Generating...' : 'Generate Social Post'}
          </Button>
        )}
      </header>

      {!hasGenerated && !loading && (
        <p className="text-sm text-muted-foreground">
          Generate a ready-to-post caption from the before/after photos on this job.
        </p>
      )}

      {loading && !post && (
        <div className="flex items-center justify-center py-8">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Sparkles className="size-4 animate-pulse" />
            Writing your caption...
          </div>
        </div>
      )}

      {hasGenerated && (
        <div className="space-y-4">
          <Tabs value={platform} onValueChange={handlePlatformChange}>
            <TabsList>
              <TabsTrigger value="instagram">Instagram</TabsTrigger>
              <TabsTrigger value="facebook">Facebook</TabsTrigger>
            </TabsList>
            <TabsContent value="instagram">
              {post && (
                <SocialPostPreview
                  post={post}
                  businessName={businessName}
                  onRegenerate={() => generate('instagram')}
                  onUpdate={(caption, hashtags) => setPost({ ...post, caption, hashtags })}
                  isRegenerating={loading}
                />
              )}
            </TabsContent>
            <TabsContent value="facebook">
              {post && (
                <SocialPostPreview
                  post={post}
                  businessName={businessName}
                  onRegenerate={() => generate('facebook')}
                  onUpdate={(caption, hashtags) => setPost({ ...post, caption, hashtags })}
                  isRegenerating={loading}
                />
              )}
            </TabsContent>
          </Tabs>
        </div>
      )}
    </section>
  );
}
