import { test } from "node:test";
import assert from "node:assert/strict";
import { vmName, ownerLabel, sslipHost, redirectUri, ipName, quotaFor } from "./gcp-lib.mjs";

test("vmName sanitizes a gcloud account to a valid GCE name", () => {
  assert.equal(vmName("ky@chaostheory.hk"), "ao-ky-chaostheory-hk");
  assert.match(vmName("A.B+C@x"), /^ao-[a-z0-9-]+$/);
  // no leading/trailing dash, no double dash
  assert.doesNotMatch(vmName("..weird..@@x.."), /--|^ao--|-$/);
});

test("vmName stays within GCE's 63-char limit", () => {
  const long = "a".repeat(100) + "@example.com";
  assert.ok(vmName(long).length <= 63);
});

test("ownerLabel is gcloud-label-safe", () => {
  assert.match(ownerLabel("ky@chaostheory.hk"), /^[a-z0-9_-]+$/);
});

test("sslipHost turns an IP into a dashed sslip.io host", () => {
  assert.equal(sslipHost("34.12.34.56"), "34-12-34-56.sslip.io");
});

test("redirectUri builds the OAuth callback for the host", () => {
  assert.equal(redirectUri("34-12-34-56.sslip.io"),
    "https://34-12-34-56.sslip.io/auth/oauth2/google/authorization-code-callback");
});

test("vmName supports an index for multi-VM users (index 1 = no suffix)", () => {
  assert.equal(vmName("ky@chaostheory.hk", 1), "ao-ky-chaostheory-hk");
  assert.equal(vmName("ky@chaostheory.hk", 2), "ao-ky-chaostheory-hk-2");
  assert.ok(vmName("a".repeat(100) + "@x", 3).length <= 63);
});

test("ipName mirrors vmName indexing", () => {
  assert.equal(ipName("ky@chaostheory.hk", 1), "ao-ky-chaostheory-hk-ip");
  assert.equal(ipName("ky@chaostheory.hk", 2), "ao-ky-chaostheory-hk-ip-2");
});

test("quotaFor reads per-user quota with default fallback", () => {
  const doc = JSON.stringify({ default: 1, "ky@chaostheory.hk": 3 });
  assert.equal(quotaFor(doc, "ky@chaostheory.hk"), 3);
  assert.equal(quotaFor(doc, "someone@else.com"), 1);
});

test("quotaFor tolerates a missing/invalid doc (default 1)", () => {
  assert.equal(quotaFor("", "x@y"), 1);
  assert.equal(quotaFor("not json", "x@y"), 1);
  assert.equal(quotaFor("{}", "x@y"), 1);
});
