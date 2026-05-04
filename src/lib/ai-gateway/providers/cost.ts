/**
 * Cost calculation. Each provider exports its own rate table; this
 * module just turns tokens × rate into cost_micros (millionths of a
 * cent — see types.ts for the rationale).
 *
 * Math:
 *   $0.15 per 1M input tokens
 *     = 0.15 USD/M = 15 cents/M = 15,000,000 micros/M = 15 micros/token
 *
 * When a model is missing from the table we charge 0 micros + log a
 * warning (caught at the adapter layer). Better to under-count than
 * to crash on a model rename — telemetry will surface the gap.
 */

export type ModelRates = {
  /** Micros (millionths of a cent) per input token. */
  input_micros_per_token: number;
  /** Micros per output token. */
  output_micros_per_token: number;
};

/**
 * Convert USD per million tokens to micros per token.
 *   usdPerMillion = $0.15 → 15 micros/token
 */
export function usdPerMillionToMicros(usdPerMillion: number): number {
  // 1 USD = 100 cents = 100_000_000 micros
  // micros/token = usdPerMillion * 100_000_000 / 1_000_000
  //              = usdPerMillion * 100
  return Math.round(usdPerMillion * 100);
}

export function computeCostMicros(
  tokens_in: number,
  tokens_out: number,
  rates: ModelRates,
): bigint {
  return (
    BigInt(tokens_in) * BigInt(rates.input_micros_per_token) +
    BigInt(tokens_out) * BigInt(rates.output_micros_per_token)
  );
}

/**
 * Look up rates by model id, falling back to a `*` wildcard (cheap
 * default) when the model isn't in the table. Adapters call this so
 * they don't have to special-case "unknown model" everywhere.
 */
export function lookupRates(table: Record<string, ModelRates>, model: string): ModelRates {
  if (model in table) return table[model];
  // Strip the version suffix and try again — e.g. "gpt-4o-mini-2024-07-18"
  // falls back to "gpt-4o-mini".
  for (const key of Object.keys(table)) {
    if (model.startsWith(key)) return table[key];
  }
  return table['*'] ?? { input_micros_per_token: 0, output_micros_per_token: 0 };
}
