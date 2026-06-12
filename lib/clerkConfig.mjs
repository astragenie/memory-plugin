// Resolve Clerk OIDC endpoints from a single CORTEX_CLERK_AUTHORITY env var.
// Authority example: https://acme.clerk.accounts.dev (dev) or https://clerk.cortex.app (prod).
// Endpoints follow OIDC discovery; we hard-code paths Clerk publishes today
// to keep the CLI dependency-free (no openid-client / no fetch-then-parse).
export function resolveClerkConfig() {
  const authority = process.env.CORTEX_CLERK_AUTHORITY;
  if (!authority) {
    throw new Error('CORTEX_CLERK_AUTHORITY env var is required (e.g. https://acme.clerk.accounts.dev)');
  }
  const clientId = process.env.CORTEX_CLERK_CLIENT_ID;
  if (!clientId) {
    throw new Error('CORTEX_CLERK_CLIENT_ID env var is required (Clerk OAuth application client_id)');
  }
  return {
    authority,
    clientId,
    authorizationEndpoint: `${authority}/oauth/authorize`,
    tokenEndpoint:         `${authority}/oauth/token`,
    jwksUri:               `${authority}/.well-known/jwks.json`,
    redirectUri:           process.env.CORTEX_CLERK_REDIRECT_URI || 'http://127.0.0.1:53682/callback',
  };
}
