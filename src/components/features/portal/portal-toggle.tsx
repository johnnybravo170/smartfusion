'use client';

import { useState } from 'react';
import { sendPortalInviteAction, togglePortalAction } from '@/server/actions/portal-updates';

export function PortalToggle({
  projectId,
  portalEnabled,
  portalSlug,
}: {
  projectId: string;
  portalEnabled: boolean;
  portalSlug: string | null;
}) {
  const [enabled, setEnabled] = useState(portalEnabled);
  const [slug, _setSlug] = useState(portalSlug);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const portalUrl = slug ? `https://app.heyhenry.io/portal/${slug}` : null;

  async function handleToggle() {
    setLoading(true);
    setMessage(null);
    const result = await togglePortalAction({ projectId, enabled: !enabled });
    if (result.ok) {
      setEnabled(!enabled);
      if (!enabled) {
        // Refresh to get the slug
        window.location.reload();
      }
    } else {
      setMessage(result.error);
    }
    setLoading(false);
  }

  async function handleCopy() {
    if (!portalUrl) return;
    await navigator.clipboard.writeText(portalUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleSendInvite() {
    setLoading(true);
    setMessage(null);
    const result = await sendPortalInviteAction(projectId);
    if (result.ok) {
      setMessage('Portal invite sent!');
    } else {
      setMessage(result.error);
    }
    setLoading(false);
  }

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Homeowner Portal</h3>
          <p className="text-xs text-muted-foreground">
            Give your customer a live view of project progress
          </p>
        </div>
        <button
          type="button"
          onClick={handleToggle}
          disabled={loading}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            enabled ? 'bg-primary' : 'bg-gray-200'
          } disabled:opacity-50`}
          role="switch"
          aria-checked={enabled}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {enabled && portalUrl ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
              {portalUrl}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted/50"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <button
            type="button"
            onClick={handleSendInvite}
            disabled={loading}
            className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"
          >
            Share with Customer
          </button>
        </div>
      ) : null}

      {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
    </div>
  );
}
