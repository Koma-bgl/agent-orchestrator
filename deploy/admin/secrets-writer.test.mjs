import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidSecret, buildAddVersionRequest } from "./secrets-writer.mjs";

test("isValidSecret accepts known secret names only", () => {
	assert.equal(isValidSecret("github-pat"), true);
	assert.equal(isValidSecret("claude-oauth-token"), true);
	assert.equal(isValidSecret("linear-api-key"), true);
	assert.equal(isValidSecret("evil; rm -rf"), false);
	assert.equal(isValidSecret(""), false);
});

test("buildAddVersionRequest builds the correct URL + base64 body", () => {
	const { url, body } = buildAddVersionRequest("my-proj", "github-pat", "ghp_abc");
	assert.equal(url, "https://secretmanager.googleapis.com/v1/projects/my-proj/secrets/github-pat:addVersion");
	assert.equal(JSON.parse(body).payload.data, Buffer.from("ghp_abc", "utf8").toString("base64"));
});

test("buildAddVersionRequest rejects an unknown secret", () => {
	assert.throws(() => buildAddVersionRequest("p", "nope", "x"));
});
