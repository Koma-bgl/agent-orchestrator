// Pure helpers for the valhalla-dev-bot skill. No I/O — unit-tested in lib.test.mjs.

// The THREE shared, deployment-level secrets that live in Secret Manager.
// Agent creds (github-pat / claude-oauth-token) are deliberately NOT here —
// they are per-user/per-VM, set on the box (gh auth login / claude setup-token).
export const GATE_SECRETS = ["google-oauth-client", "jwt-shared-key", "dashboard-allowlist"];

/**
 * Parse the `google-oauth-client` secret, stored as "CLIENT_ID|CLIENT_SECRET".
 * Splits on the FIRST `|` (the id never contains one; the secret won't either).
 */
export function parseGoogleClient(raw) {
	const v = String(raw ?? "").trim();
	const i = v.indexOf("|");
	if (i < 0) throw new Error("google-oauth-client must be 'CLIENT_ID|CLIENT_SECRET'");
	const id = v.slice(0, i).trim();
	const secret = v.slice(i + 1).trim();
	if (!id || !secret) throw new Error("google-oauth-client id or secret is empty");
	return { id, secret };
}

/**
 * Render the transient deploy/.env. Agent tokens are emitted EMPTY by design
 * (on-box auth). Values are interpolated verbatim — callers must not pass
 * untrusted multi-line input.
 */
export function buildEnv({ googleId, googleSecret, jwt, allowlist, watchtowerToken }) {
	return [
		"AO_SECRET_SOURCE=env",
		`GOOGLE_CLIENT_ID=${googleId}`,
		`GOOGLE_CLIENT_SECRET=${googleSecret}`,
		`JWT_SHARED_KEY=${jwt}`,
		`ALLOWED_EMAIL_1=${allowlist}`,
		"GITHUB_TOKEN=", // agent creds are on-box, not fetched
		"CLAUDE_CODE_OAUTH_TOKEN=",
		"AO_SITE_ADDRESS=localhost:8443",
		"AO_SITE_URL=https://localhost:8443",
		`WATCHTOWER_TOKEN=${watchtowerToken}`,
		"",
	].join("\n");
}
