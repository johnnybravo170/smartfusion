/**
 * QuickBooks Online environment + URL helpers.
 *
 * All QBO secrets live in env (per `secrets.ts` env fallback convention).
 * Centralized here so route handlers and server actions don't pluck from
 * `process.env` directly.
 */

export type QboEnvironment = 'sandbox' | 'production';

export type QboEnv = {
  clientId: string;
  clientSecret: string;
  environment: QboEnvironment;
  redirectUri: string;
  /** HMAC key for signing OAuth state cookies. */
  stateSecret: string;
};

function req(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function getQboEnv(): QboEnv {
  const environment = (process.env.QBO_ENVIRONMENT ?? 'sandbox') as QboEnvironment;
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error(`QBO_ENVIRONMENT must be 'sandbox' or 'production', got: ${environment}`);
  }

  const stateSecret =
    process.env.QBO_STATE_SECRET ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    (() => {
      throw new Error('QBO_STATE_SECRET unset and SUPABASE_SERVICE_ROLE_KEY fallback missing');
    })();

  return {
    clientId: req('QBO_CLIENT_ID'),
    clientSecret: req('QBO_CLIENT_SECRET'),
    environment,
    redirectUri: req('QBO_REDIRECT_URI'),
    stateSecret,
  };
}

/**
 * Intuit OAuth/discovery endpoints. Same hosts for sandbox and production —
 * environment only affects the QBO API host (see `getQboApiBase`).
 */
export const QBO_OAUTH_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const QBO_OAUTH_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const QBO_OAUTH_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

/**
 * Base URL for the QBO accounting API. Sandbox routes through a separate
 * host so test data can't leak into production reports.
 */
export function getQboApiBase(environment: QboEnvironment): string {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

/**
 * OAuth scopes requested at connect time. V1 only needs accounting; payroll
 * scope is added later when the Payroll Canada hours-sync card lands.
 */
export const QBO_OAUTH_SCOPES = ['com.intuit.quickbooks.accounting'];
