import { ServerClient } from 'postmark';

let _client: ServerClient | null = null;

export function getPostmark(): ServerClient {
  if (!_client) {
    if (!process.env.POSTMARK_SERVER_TOKEN) {
      throw new Error('POSTMARK_SERVER_TOKEN is required at runtime');
    }
    _client = new ServerClient(process.env.POSTMARK_SERVER_TOKEN);
  }
  return _client;
}

// Stream IDs configured in the Postmark dashboard. Each stream has its
// own reputation, configurable per-stream tracking, and independent
// suppression lists. send.ts routes each send to one of these based on
// intent (transactional vs marketing vs tenant-originated).
export const STREAM_TRANSACTIONAL = 'outbound-transactional';
export const STREAM_MARKETING = 'outbound-marketing';
export const STREAM_TENANTS = 'outbound-tenants';

// FROM addresses per stream. Each subdomain has its own DKIM-signed
// sender reputation in Postmark — see docs/email-architecture.md for the
// "why subdomains" rationale. Defaults match the verified Sender
// Signatures; env-var overrides available without redeploy.
export const FROM_EMAIL_TRANSACTIONAL =
  process.env.POSTMARK_FROM_EMAIL_TRANSACTIONAL || 'HeyHenry <noreply@mail.heyhenry.io>';

export const FROM_EMAIL_MARKETING =
  process.env.POSTMARK_FROM_EMAIL_MARKETING || 'HeyHenry <newsletters@send.heyhenry.io>';

// Bare address used in tenant-from-header building (display name comes
// from tenant.name, address comes from this constant).
export const FROM_EMAIL_TENANTS_ADDR =
  process.env.POSTMARK_FROM_EMAIL_TENANTS || 'noreply@tenants.heyhenry.io';

// Legacy export — points at the transactional default for backward-compat
// with callsites importing `FROM_EMAIL`. New code should pick the explicit
// per-stream constant.
export const FROM_EMAIL = FROM_EMAIL_TRANSACTIONAL;
