/**
 * Social post preview card — looks like an Instagram post.
 *
 * Shows the before/after comparison, AI-generated caption, hashtags,
 * and action buttons (copy caption, download images, regenerate).
 */

'use client';

import { Check, ClipboardCopy, Download, Pencil, RefreshCw, Share2 } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { SocialPostResponse } from '@/app/api/social-post/route';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { BeforeAfterCompare } from './before-after-compare';

type SocialPostPreviewProps = {
  post: SocialPostResponse;
  businessName: string;
  onRegenerate: () => void;
  onUpdate: (caption: string, hashtags: string[]) => void;
  isRegenerating: boolean;
};

export function SocialPostPreview({
  post,
  businessName,
  onRegenerate,
  onUpdate,
  isRegenerating,
}: SocialPostPreviewProps) {
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editCaption, setEditCaption] = useState(post.caption);
  const [editHashtags, setEditHashtags] = useState(post.hashtags.join(' '));
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fullCaption = [
    post.caption,
    '',
    post.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' '),
  ].join('\n');

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(fullCaption);
      setCopied(true);
      toast.success('Caption copied! Paste into Instagram.');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy. Try selecting the text manually.');
    }
  }, [fullCaption]);

  const handleShare = useCallback(async () => {
    try {
      // Copy caption to clipboard first (share sheet doesn't always support text + files together)
      await navigator.clipboard.writeText(fullCaption);

      // Fetch both images as files for the share sheet
      const [beforeRes, afterRes] = await Promise.all([
        fetch(post.beforeUrl),
        fetch(post.afterUrl),
      ]);
      const [beforeBlob, afterBlob] = await Promise.all([beforeRes.blob(), afterRes.blob()]);

      const files = [
        new File([beforeBlob], 'before.jpg', { type: beforeBlob.type || 'image/jpeg' }),
        new File([afterBlob], 'after.jpg', { type: afterBlob.type || 'image/jpeg' }),
      ];

      if (navigator.canShare?.({ files })) {
        await navigator.share({
          text: fullCaption,
          files,
        });
        toast.success('Shared! Caption also copied to clipboard.');
      } else {
        // Fallback: just share text (older browsers or desktop)
        await navigator.share({
          text: fullCaption,
        });
        toast.success('Caption shared! Download images separately.');
      }
    } catch (e: unknown) {
      // User cancelled the share sheet — not an error
      if (e instanceof Error && e.name === 'AbortError') return;
      toast.error('Sharing not available on this device. Use copy + download instead.');
    }
  }, [fullCaption, post.beforeUrl, post.afterUrl]);

  const canShare = typeof navigator !== 'undefined' && !!navigator.share;

  const handleDownload = useCallback(
    async (url: string, label: string) => {
      try {
        const response = await fetch(url);
        const blob = await response.blob();
        const ext = blob.type.includes('png') ? 'png' : 'jpg';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${businessName.toLowerCase().replace(/\s+/g, '-')}-${label}.${ext}`;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch {
        toast.error(`Failed to download ${label} image.`);
      }
    },
    [businessName],
  );

  return (
    <Card className="overflow-hidden">
      <BeforeAfterCompare beforeUrl={post.beforeUrl} afterUrl={post.afterUrl} />
      <CardContent className="space-y-3 pt-2">
        {/* Business name header (like IG) */}
        <p className="text-sm font-semibold">{businessName}</p>

        {isEditing ? (
          <div className="space-y-2">
            <textarea
              ref={textareaRef}
              value={editCaption}
              onChange={(e) => setEditCaption(e.target.value)}
              className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
              rows={3}
            />
            <input
              value={editHashtags}
              onChange={(e) => setEditHashtags(e.target.value)}
              placeholder="#pressurewashing #abbotsford"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm text-blue-600 focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  const tags = editHashtags
                    .split(/[\s,]+/)
                    .filter(Boolean)
                    .map((t) => (t.startsWith('#') ? t : `#${t}`));
                  onUpdate(editCaption, tags);
                  setIsEditing(false);
                }}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditCaption(post.caption);
                  setEditHashtags(post.hashtags.join(' '));
                  setIsEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* Caption */}
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{post.caption}</p>
            {/* Hashtags */}
            {post.hashtags.length > 0 && (
              <p className="text-sm text-blue-600 dark:text-blue-400">
                {post.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')}
              </p>
            )}
          </>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        {canShare && (
          <Button size="sm" onClick={handleShare}>
            <Share2 className="size-3.5" />
            Share to Instagram
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={handleCopy}>
          {copied ? <Check className="size-3.5" /> : <ClipboardCopy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy caption'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            handleDownload(post.beforeUrl, 'before');
            handleDownload(post.afterUrl, 'after');
          }}
        >
          <Download className="size-3.5" />
          Download images
        </Button>
        {!isEditing && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setEditCaption(post.caption);
              setEditHashtags(
                post.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' '),
              );
              setIsEditing(true);
              setTimeout(() => textareaRef.current?.focus(), 100);
            }}
          >
            <Pencil className="size-3.5" />
            Edit
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onRegenerate} disabled={isRegenerating}>
          <RefreshCw className={`size-3.5 ${isRegenerating ? 'animate-spin' : ''}`} />
          Regenerate
        </Button>
      </CardFooter>
    </Card>
  );
}
