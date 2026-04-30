'use client';

/**
 * Bookkeeper invite card — creates a role='bookkeeper' invite that lands
 * the invitee on /bk after accepting. Minimal UX: name + email, generate
 * link, copy/email. No fine-grained permissions per invite (bookkeeper
 * role scope is fixed server-side).
 */

import { Copy, Loader2, Send } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createWorkerInviteAction } from '@/server/actions/team';

export function InviteBookkeeperCard() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [joinUrl, setJoinUrl] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleInvite() {
    if (!email.includes('@')) {
      toast.error('Enter a valid email address.');
      return;
    }
    startTransition(async () => {
      const res = await createWorkerInviteAction({
        role: 'bookkeeper',
        invited_name: name.trim() || undefined,
        invited_email: email.trim(),
      });
      if (!res.ok) {
        toast.error(res.error ?? 'Failed to create invite.');
        return;
      }
      setJoinUrl(res.joinUrl ?? null);
      toast.success('Bookkeeper invited. Email sent.');
    });
  }

  async function copyLink() {
    if (!joinUrl) return;
    await navigator.clipboard.writeText(joinUrl);
    toast.success('Link copied');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Invite your bookkeeper</CardTitle>
        <CardDescription>
          They get access to expenses, bills, invoices, GST/HST remittance, and year-end exports —
          no customer details or project content.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bk-name">Name (optional)</Label>
              <Input
                id="bk-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Sarah"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bk-email">Email</Label>
              <Input
                id="bk-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="sarah@bookkeepingco.com"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={handleInvite} disabled={pending || !email.trim()}>
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
              Send invite
            </Button>
          </div>
          {joinUrl ? (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <p className="mb-1 text-xs text-muted-foreground">
                Invite link (share manually if needed):
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate text-xs">{joinUrl}</code>
                <Button type="button" size="sm" variant="outline" onClick={copyLink}>
                  <Copy className="size-3.5" />
                  Copy
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
