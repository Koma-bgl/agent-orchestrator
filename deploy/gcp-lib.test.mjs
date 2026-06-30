import { test } from "node:test";
import assert from "node:assert/strict";
import { vmName, ownerLabel, sslipHost, redirectUri } from "./gcp-lib.mjs";

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
