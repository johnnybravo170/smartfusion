'use client';

import { ExternalLink, FileText, FolderTree, History, Loader2, Unplug } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useTransition } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { connectQboAction, disconnectQboAction } from '@/server/actions/qbo';
import { QuickBooksImportLauncher } from './quickbooks-import-launcher';

type Props = {
  realmId: string | null;
  companyName: string | null;
  connectedAt: string | null;
  environment: 'sandbox' | 'production' | null;
};

export function QuickBooksConnectCard({ realmId, companyName, connectedAt, environment }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const qboParam = searchParams?.get('qbo');
  const isConnected = Boolean(realmId && connectedAt);

  // Handle return from Intuit OAuth.
  useEffect(() => {
    if (!qboParam) return;
    if (qboParam === 'connected') {
      toast.success('QuickBooks connected.');
    } else if (qboParam === 'denied') {
      toast.info('Connection cancelled.');
    } else if (qboParam === 'invalid') {
      toast.error('Connection link expired. Try again.');
    } else if (qboParam === 'error') {
      toast.error('Could not connect to QuickBooks. Try again or contact support.');
    }
    router.replace('/settings');
  }, [qboParam, router]);

  function handleConnect() {
    startTransition(async () => {
      const result = await connectQboAction();
      if (result.ok && result.url) {
        window.location.href = result.url;
      } else if (!result.ok) {
        toast.error(result.error);
      }
    });
  }

  function handleDisconnect() {
    startTransition(async () => {
      const result = await disconnectQboAction();
      if (result.ok) {
        toast.success('QuickBooks disconnected.');
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="size-5" />
          QuickBooks Online
        </CardTitle>
        <CardDescription>
          Import historical customers, invoices, payments, and expenses from your QuickBooks
          company. Coming soon: every new invoice and payment auto-syncs to QBO.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isConnected ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
              <div className="flex flex-1 flex-col gap-1">
                <p className="text-sm font-medium text-emerald-800 dark:text-emerald-200">
                  Connected{companyName ? ` to ${companyName}` : ''}
                </p>
                <p className="font-mono text-xs text-emerald-600 dark:text-emerald-400">
                  realm {realmId}
                  {environment === 'sandbox' ? ' · sandbox' : ''}
                </p>
              </div>
            </div>

            <QuickBooksImportLauncher />

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link href="/settings/qbo-history">
                  <History className="size-3.5" />
                  Import history
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link href="/settings/qbo-class-mapping">
                  <FolderTree className="size-3.5" />
                  Map Classes
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <a
                  href={
                    environment === 'sandbox'
                      ? 'https://sandbox.qbo.intuit.com'
                      : 'https://qbo.intuit.com'
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="size-3.5" />
                  Open QuickBooks
                </a>
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-destructive">
                    <Unplug className="size-3.5" />
                    Disconnect
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Disconnect QuickBooks?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Imported records stay in HeyHenry. Future sync stops until you reconnect.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleDisconnect} disabled={isPending}>
                      {isPending && <Loader2 className="size-3.5 animate-spin" />}
                      Disconnect
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Connect once. We&rsquo;ll pull your customers, invoices, payments, and expenses so
              your historical work shows up in HeyHenry from day one.
            </p>
            <Button onClick={handleConnect} disabled={isPending}>
              {isPending && <Loader2 className="size-3.5 animate-spin" />}
              Connect QuickBooks
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
