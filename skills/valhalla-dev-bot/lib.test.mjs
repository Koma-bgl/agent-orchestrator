import { test } from "node:test";
import assert from "node:assert/strict";
import { GATE_SECRETS, parseGoogleClient, buildEnv } from "./lib.mjs";

test("GATE_SECRETS is exactly the three shared gate secrets", () => {
	assert.deepEqual([...GATE_SECRETS].sort(), ["dashboard-allowlist", "google-oauth-client", "jwt-shared-key"]);
});

test("parseGoogleClient splits id|secret", () => {
	const r = parseGoogleClient("123.apps.googleusercontent.com|GOCSPX-abc");
	assert.equal(r.id, "123.apps.googleusercontent.com");
	assert.equal(r.secret, "GOCSPX-abc");
});

test("parseGoogleClient trims surrounding whitespace/newlines", () => {
	const r = parseGoogleClient("  id123|sec456  \n");
	assert.equal(r.id, "id123");
	assert.equal(r.secret, "sec456");
});

test("parseGoogleClient throws on missing separator", () => {
	assert.throws(() => parseGoogleClient("no-separator-here"));
});

test("parseGoogleClient throws on empty id or secret", () => {
	assert.throws(() => parseGoogleClient("|sec"));
	assert.throws(() => parseGoogleClient("id|"));
});

test("buildEnv renders all keys; agent tokens empty (on-box model)", () => {
	const env = buildEnv({
		googleId: "gid",
		googleSecret: "gsec",
		jwt: "jjj",
		allowlist: "me@x.com",
		watchtowerToken: "wt",
	});
	assert.match(env, /^AO_SECRET_SOURCE=env$/m);
	assert.match(env, /^GOOGLE_CLIENT_ID=gid$/m);
	assert.match(env, /^GOOGLE_CLIENT_SECRET=gsec$/m);
	assert.match(env, /^JWT_SHARED_KEY=jjj$/m);
	assert.match(env, /^ALLOWED_EMAIL_1=me@x\.com$/m);
	assert.match(env, /^WATCHTOWER_TOKEN=wt$/m);
	assert.match(env, /^GITHUB_TOKEN=$/m); // on-box, intentionally empty
	assert.match(env, /^CLAUDE_CODE_OAUTH_TOKEN=$/m); // on-box, intentionally empty
	assert.match(env, /^AO_SITE_ADDRESS=localhost:8443$/m);
	assert.match(env, /^AO_SITE_URL=https:\/\/localhost:8443$/m);
});
