'use server';

/**
 * Server action wrapper for the per-line spend rollup. Lets the
 * client-side <CostLineActualsInline> fetch on demand via a regular
 * server action call.
 */

import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import {
  type CostLineActualsSummary,
  getCostLineActuals,
} from '@/lib/db/queries/cost-line-actuals';

export type FetchCostLineActualsResult =
  | { ok: true; actuals: CostLineActualsSummary }
  | { ok: false; error: string };

const idSchema = z.string().uuid();

export async function fetchCostLineActualsAction(
  costLineId: string,
): Promise<FetchCostLineActualsResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = idSchema.safeParse(costLineId);
  if (!parsed.success) return { ok: false, error: 'Invalid line.' };

  const actuals = await getCostLineActuals(parsed.data);
  return { ok: true, actuals };
}
