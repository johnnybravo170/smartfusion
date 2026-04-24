'use client';

import { useState } from 'react';
import { approveChangeOrderAction, declineChangeOrderAction } from '@/server/actions/change-orders';

export function ApprovalForm({ approvalCode }: { approvalCode: string }) {
  const [mode, setMode] = useState<'pending' | 'approve' | 'decline' | 'done'>('pending');
  const [name, setName] = useState('');
  const [declineReason, setDeclineReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultMessage, setResultMessage] = useState('');

  async function handleApprove() {
    if (!name.trim()) {
      setError('Please type your name to approve.');
      return;
    }
    setLoading(true);
    setError(null);
    const result = await approveChangeOrderAction(approvalCode, name.trim());
    if (!result.ok) {
      setError(result.error);
      setLoading(false);
      return;
    }
    setResultMessage('Change order approved. Your contractor has been notified.');
    setMode('done');
    setLoading(false);
  }

  async function handleDecline() {
    setLoading(true);
    setError(null);
    const result = await declineChangeOrderAction(approvalCode, declineReason.trim() || undefined);
    if (!result.ok) {
      setError(result.error);
      setLoading(false);
      return;
    }
    setResultMessage('Change order declined. Your contractor has been notified.');
    setMode('done');
    setLoading(false);
  }

  if (mode === 'done') {
    return (
      <div className="rounded-md bg-muted/50 p-6 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
          <svg
            aria-hidden="true"
            className="h-6 w-6 text-emerald-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="text-sm font-medium">{resultMessage}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error ? <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}

      {mode === 'pending' ? (
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setMode('approve')}
            className="flex-1 rounded-md bg-emerald-600 px-4 py-3 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => setMode('decline')}
            className="flex-1 rounded-md border border-red-200 px-4 py-3 text-sm font-medium text-red-700 hover:bg-red-50"
          >
            Decline
          </button>
        </div>
      ) : null}

      {mode === 'approve' ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Type your name below to approve this change order.
          </p>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
            placeholder="Your full name"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleApprove}
              disabled={loading}
              className="flex-1 rounded-md bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {loading ? 'Approving...' : 'Confirm Approval'}
            </button>
            <button
              type="button"
              onClick={() => setMode('pending')}
              disabled={loading}
              className="rounded-md border px-3 py-2.5 text-sm font-medium hover:bg-muted/50 disabled:opacity-50"
            >
              Back
            </button>
          </div>
        </div>
      ) : null}

      {mode === 'decline' ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Optionally provide a reason for declining.
          </p>
          <textarea
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            rows={3}
            className="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-400"
            placeholder="Reason (optional)"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleDecline}
              disabled={loading}
              className="flex-1 rounded-md bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {loading ? 'Declining...' : 'Confirm Decline'}
            </button>
            <button
              type="button"
              onClick={() => setMode('pending')}
              disabled={loading}
              className="rounded-md border px-3 py-2.5 text-sm font-medium hover:bg-muted/50 disabled:opacity-50"
            >
              Back
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
