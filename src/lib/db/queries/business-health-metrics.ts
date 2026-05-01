/**
 * Business Health overview metrics — single round-trip aggregator.
 *
 * Wraps the `get_business_health_metrics(p_year INT)` RPC. The function is
 * SECURITY INVOKER, so the calling user's RLS scopes the result to their
 * tenant. See `supabase/migrations/0169_business_health_metrics_rpc.sql`.
 */

import type { OwnerDrawType } from '@/lib/db/schema/owner-draws';
import { createClient } from '@/lib/supabase/server';

export type BusinessHealthMetrics = {
  year: number;
  fy_start: string;
  fy_end: string;
  revenue_ytd_cents: number;
  ar_outstanding: {
    total_cents: number;
    count: number;
    oldest_at: string | null;
  };
  ap_outstanding: {
    total_cents: number;
    count: number;
  };
  owner_pay_ytd: {
    total_cents: number;
    by_type: Partial<Record<OwnerDrawType, number>>;
  };
  outflows_ytd_cents: number;
  net_cash_flow_ytd_cents: number;
};

export async function getBusinessHealthMetrics(year?: number): Promise<BusinessHealthMetrics> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('get_business_health_metrics', {
    p_year: year ?? null,
  });

  if (error) {
    throw new Error(`Failed to load business health metrics: ${error.message}`);
  }

  // RPC returns JSONB. Supabase deserializes it; cents come back as numbers
  // (Postgres BIGINT serialized as JSON number — safe up to 2^53, well past
  // anything realistic for cents at our scale).
  return data as BusinessHealthMetrics;
}
