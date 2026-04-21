/**
 * Lazy env access. Throws only when a value is actually read, so Next's
 * build-time page data collection (which runs without prod envs) doesn't
 * blow up on import. Every server handler or action that reaches for a
 * value still fails loudly if it's missing at runtime.
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  get supabaseUrl() {
    return req('NEXT_PUBLIC_SUPABASE_URL');
  },
  get supabaseAnonKey() {
    return req('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  },
  get supabaseServiceRoleKey() {
    return req('SUPABASE_SERVICE_ROLE_KEY');
  },
  get opsKeyPepper() {
    return req('OPS_KEY_PEPPER');
  },
  get alertsFromEmail() {
    return process.env.OPS_ALERTS_FROM_EMAIL ?? 'ops@mail.heyhenry.io';
  },
  get alertsToEmail() {
    return process.env.OPS_ALERTS_TO_EMAIL ?? 'riffninjavideos@gmail.com';
  },
  get resendApiKey() {
    return process.env.RESEND_API_KEY ?? null;
  },
};
