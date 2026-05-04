/**
 * Multi-key support for AI providers. Each provider's keys are read from
 * a comma-separated env var with optional `key:label` pairs:
 *
 *   OPENAI_API_KEYS=sk-personal:personal,sk-heyhenry-prod:heyhenry-prod
 *   GEMINI_API_KEYS=AIza-xxx
 *   ANTHROPIC_API_KEYS=sk-ant-yyy:default
 *
 * Labels appear in telemetry (`api_key_label`) so cost / quota usage can
 * be sliced by org or project. Missing labels default to `default-N`.
 *
 * Backward-compat: each provider also reads its singular env var
 * (`OPENAI_API_KEY` etc.) so we don't break the existing setup.
 *
 * Selection: round-robin via a per-provider in-memory counter. Per-key
 * weighted selection (e.g. shift more spend to a specific org) belongs
 * here when we need it; the routing-tune roadmap entry covers it.
 */

export type ApiKey = {
  /** The actual secret. Never logged. */
  secret: string;
  /** Telemetry label shown on ai_calls + admin dashboard. */
  label: string;
};

const counters = new Map<string, number>();

/**
 * Parse a comma-separated env value into typed ApiKey records.
 * Strips whitespace + drops empty entries; tolerates trailing commas.
 */
export function parseKeyEnv(rawList: string | undefined, fallback: string | undefined): ApiKey[] {
  const sources: string[] = [];
  if (rawList && rawList.trim())
    sources.push(
      ...rawList
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  if (sources.length === 0 && fallback && fallback.trim()) sources.push(fallback.trim());
  return sources.map((entry, idx) => {
    const colonAt = entry.indexOf(':');
    if (colonAt < 0) return { secret: entry, label: `default-${idx}` };
    return {
      secret: entry.slice(0, colonAt).trim(),
      label: entry.slice(colonAt + 1).trim() || `default-${idx}`,
    };
  });
}

/**
 * Pick the next key in round-robin order. Returns undefined when no
 * keys are configured — caller should bail with an `auth` AiError.
 */
export function pickKey(scope: string, keys: ApiKey[]): ApiKey | undefined {
  if (keys.length === 0) return undefined;
  const next = (counters.get(scope) ?? 0) % keys.length;
  counters.set(scope, next + 1);
  return keys[next];
}

/** Test-only: reset counters between specs. */
export function resetCountersForTests(): void {
  counters.clear();
}
