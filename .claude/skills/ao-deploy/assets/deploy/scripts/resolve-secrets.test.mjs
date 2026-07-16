import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseSource, SECRET_ENV_MAP, secretNames } from "./resolve-secrets.mjs";

test("chooseSource honors explicit AO_SECRET_SOURCE", () => {
  assert.equal(chooseSource({ AO_SECRET_SOURCE: "gcp" }), "gcp");
  assert.equal(chooseSource({ AO_SECRET_SOURCE: "env" }), "env");
});

test("chooseSource defaults to gcp when project is set", () => {
  assert.equal(chooseSource({ AO_GCP_PROJECT: "my-proj" }), "gcp");
});

test("chooseSource defaults to env when nothing is set", () => {
  assert.equal(chooseSource({}), "env");
});

test("explicit env source overrides project presence", () => {
  assert.equal(chooseSource({ AO_SECRET_SOURCE: "env", AO_GCP_PROJECT: "p" }), "env");
});

test("secret env map covers the three M2 secrets", () => {
  assert.deepEqual(secretNames(), ["claude-oauth-token", "github-pat", "linear-api-key"]);
  assert.equal(SECRET_ENV_MAP["claude-oauth-token"], "CLAUDE_CODE_OAUTH_TOKEN");
  // GITHUB_TOKEN (not GH_TOKEN): the Go daemon reads AO_GITHUB_TOKEN/GITHUB_TOKEN
  // and gh reads GITHUB_TOKEN — one var covers both.
  assert.equal(SECRET_ENV_MAP["github-pat"], "GITHUB_TOKEN");
  // linear-api-key is mapped but NOT yet consumed by the Go build (no Linear
  // adapter). Kept forward-compatible; safe to export, simply unused for now.
  assert.equal(SECRET_ENV_MAP["linear-api-key"], "LINEAR_API_KEY");
});

test("chooseSource throws on an unknown explicit source", () => {
  assert.throws(() => chooseSource({ AO_SECRET_SOURCE: "vault" }), /AO_SECRET_SOURCE/);
});
