// Resolve Clerk OIDC endpoints from a single MEMORY_CLERK_AUTHORITY env var.
// Authority example: https://acme.clerk.accounts.dev (dev) or https://clerk.astramemory.com (prod).
// Endpoints follow OIDC discovery; we hard-code paths Clerk publishes today
// to keep the CLI dependency-free (no openid-client / no fetch-then-parse).
export function resolveClerkConfig() {
  const authority = process.env.MEMORY_CLERK_AUTHORITY;
  if (!authority) {
    throw new Error('MEMORY_CLERK_AUTHORITY env var is required (e.g. https://acme.clerk.accounts.dev)');
  }
  const clientId = process.env.MEMORY_CLERK_CLIENT_ID;
  if (!clientId) {
    throw new Error('MEMORY_CLERK_CLIENT_ID env var is required (Clerk OAuth application client_id)');
  }
  return {
    authority,
    clientId,
    authorizationEndpoint: `${authority}/oauth/authorize`,
    tokenEndpoint:         `${authority}/oauth/token`,
    jwksUri:               `${authority}/.well-known/jwks.json`,
    redirectUri:           process.env.MEMORY_CLERK_REDIRECT_URI || 'http://127.0.0.1:53682/callback',
  };
}
