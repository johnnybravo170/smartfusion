// Empty instrumentation hook for the ops package. Required so Next.js
// finds an instrumentation file at this project's src/ root and stops
// walking up to the workspace root — where it would otherwise pick up
// the parent heyhenry app's instrumentation (and its sentry config,
// which imports a path that only resolves under the parent app).
//
// If ops ever needs its own Sentry init, register it here.
export async function register(): Promise<void> {}
