# valhalla-dev-bot (alpha) skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the _already-validated_ local deploy-test flow into an invokable skill (`skills/valhalla-dev-bot/`) — one command to fetch the 3 gate secrets from Secret Manager, bring up the gated stack, verify it, and guide the human through real sign-in + on-box agent auth.

**Architecture:** A `SKILL.md` orchestrates; a Node CLI (`run.mjs`) does the deterministic mechanics (preflight, fetch, materialize `.env`, `docker compose up`, verify, teardown) via subcommands; pure helpers (`lib.mjs`) are unit-tested. The flow was proven by hand against `cloudbet-native` this session — this plan only codifies it, folding in the two learnings (robust gcloud read; agent creds are on-box, not in Secret Manager).

**Tech Stack:** Node ESM (`node:test`, `execFileSync`), gcloud CLI, docker compose. Skill format matches `skills/bug-triage/SKILL.md` (frontmatter: `name`/`description`/`trigger`).

> **Validated facts (from the live run this session):**
>
> - 3 gate secrets in Secret Manager: `google-oauth-client` (format `CLIENT_ID|CLIENT_SECRET`), `jwt-shared-key`, `dashboard-allowlist`. Agent creds (`github-pat`/`claude-oauth-token`) are **on-box**, not fetched.
> - The stack is `deploy/docker-compose.yml` (ao + caddy + watchtower); Caddy publishes `8443`; `.env` keys: `AO_SECRET_SOURCE`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `JWT_SHARED_KEY`, `ALLOWED_EMAIL_1`, `GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `AO_SITE_ADDRESS`, `AO_SITE_URL`, `WATCHTOWER_TOKEN`.
> - Verification that passed live: `GET / → 302`; `/admin/api/version → 302`; in-container `/healthz` OK; `/auth/oauth2/google → 302 accounts.google.com` with the real client_id.
> - **gcloud read flakiness:** `VAR=$(gcloud secrets versions access …)` intermittently returned empty; **file-redirect** (`gcloud … 1>file`) was reliable. The reader MUST use the robust form + assert non-empty.

### File structure

- Create `skills/valhalla-dev-bot/lib.mjs` — pure: `GATE_SECRETS`, `parseGoogleClient(raw)`, `buildEnv(opts)`.
- Create `skills/valhalla-dev-bot/lib.test.mjs` — unit tests.
- Create `skills/valhalla-dev-bot/run.mjs` — CLI: `preflight | check | up | verify | down`.
- Create `skills/valhalla-dev-bot/SKILL.md` — frontmatter + orchestration + human-guided steps.

---

## Task 1: Pure helpers (TDD)

**Files:** Create `skills/valhalla-dev-bot/lib.mjs`, `skills/valhalla-dev-bot/lib.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
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

test("parseGoogleClient trims and tolerates secret containing nothing weird", () => {
	const r = parseGoogleClient("  id123|sec456  \n");
	assert.equal(r.id, "id123");
	assert.equal(r.secret, "sec456");
});

test("parseGoogleClient throws on missing separator", () => {
	assert.throws(() => parseGoogleClient("no-separator-here"));
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
});
```

- [ ] **Step 2: Run — expect FAIL** (`node --test skills/valhalla-dev-bot/lib.test.mjs`) — module missing.

- [ ] **Step 3: Implement `lib.mjs`**

```js
export const GATE_SECRETS = ["google-oauth-client", "jwt-shared-key", "dashboard-allowlist"];

export function parseGoogleClient(raw) {
	const v = String(raw ?? "").trim();
	const i = v.indexOf("|");
	if (i < 0) throw new Error("google-oauth-client must be 'CLIENT_ID|CLIENT_SECRET'");
	const id = v.slice(0, i).trim(),
		secret = v.slice(i + 1).trim();
	if (!id || !secret) throw new Error("google-oauth-client id or secret is empty");
	return { id, secret };
}

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
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** (`feat(skill): valhalla-dev-bot pure helpers (TDD)`).

---

## Task 2: `run.mjs` — preflight + check

**Files:** Create `skills/valhalla-dev-bot/run.mjs`

- [ ] **Step 1: Implement preflight + check + a robust secret reader**

Key requirements (do NOT deviate):

- **Robust read:** `readSecret(name, project)` runs `gcloud secrets versions access latest --secret=<name> --project=<project>` writing **stdout to a temp file** (`execFileSync(..., { stdio: ["ignore", fd, "ignore"] })` or write the buffer then re-check), reads it back, and **throws if empty** — retry once before throwing. (Shell `$(...)` capture proved flaky this session.)
- `project` resolves from `--project=` arg, else `AO_PROJECT` env, else `gcloud config get-value project`.
- `preflight`: assert `docker info` works; assert a GCP credential resolves (`gcloud auth print-access-token` succeeds, or ADC, or `AO_GCP_ACCESS_TOKEN`); print the resolved project and ask the human to confirm (print, don't block).
- `check`: for each `GATE_SECRETS`, `gcloud secrets describe`; print ✓/✗. Exit non-zero if any missing, printing the exact one-time create command for the missing ones (from the design's table). Agent creds are NOT checked.

- [ ] **Step 2: Run against the real project** — `node skills/valhalla-dev-bot/run.mjs preflight` then `... check --project=cloudbet-native`.
      Expected: preflight passes; check reports all 3 gate secrets ✓ (they exist from this session).

- [ ] **Step 3: Commit** (`feat(skill): run.mjs preflight + secret check`).

---

## Task 3: `run.mjs` — up + verify + down

**Files:** Modify `skills/valhalla-dev-bot/run.mjs`

- [ ] **Step 1: Implement `up`** — read the 3 gate secrets (robust reader), `parseGoogleClient`, `buildEnv(...)` with a generated `WATCHTOWER_TOKEN` (`crypto.randomBytes(24).toString("hex")`), write `deploy/.env`, then `docker compose -f deploy/docker-compose.yml up -d --build`. Never print secret values (print key names + lengths only). (`deploy/.env` is already gitignored — confirmed via `git check-ignore deploy/.env` — so a real-secret `.env` can't be committed.)

> **All `docker compose` calls (up/verify/down) MUST use the same
> `-f deploy/docker-compose.yml`** (or run from `deploy/`) so every node invocation
> targets the same compose project. `verify`'s `docker compose exec` and `down`
> included — not just `up`.

- [ ] **Step 2: Implement `verify`** — run the proven mechanics checks and print a pass/fail table:
  - `curl -sk -o /dev/null -w %{http_code}` on `https://localhost:8443/` → expect `302`
  - same on `/admin/api/version` → `302`
  - `docker compose exec -T ao curl -fsS http://127.0.0.1:3001/healthz` → ok
  - `curl -sk -i https://localhost:8443/auth/oauth2/google` → `Location` contains `accounts.google.com` + a non-dummy `client_id`
    Exit non-zero if any hard check fails.

- [ ] **Step 3: Implement `down`** — `docker compose -f deploy/docker-compose.yml down` (accept `--wipe` → `down -v`).

- [ ] **Step 4: Run the full cycle against the real project**

```
node skills/valhalla-dev-bot/run.mjs up --project=cloudbet-native
node skills/valhalla-dev-bot/run.mjs verify
node skills/valhalla-dev-bot/run.mjs down
```

Expected: stack healthy; verify table all-pass (reproduces today's manual result); clean teardown.

- [ ] **Step 5: Commit** (`feat(skill): run.mjs up/verify/down`).

---

## Task 4: SKILL.md

**Files:** Create `skills/valhalla-dev-bot/SKILL.md`

- [ ] **Step 1: Write the skill doc** — frontmatter (`name: valhalla-dev-bot`, a `description`, a `trigger`), then the orchestration:
  - One-paragraph what/why (local real-flow test for the dockerized self-host deploy; alpha).
  - **The credential model in brief** (3 gate secrets in Secret Manager; agent creds on-box) so the agent doesn't try to fetch GitHub/Claude.
  - **Run order:** `preflight` → `check` (if missing, guide the one-time creates — the design's table, incl. the Console step for `google-oauth-client`) → `up` → `verify` → report.
  - **Human-guided steps (the agent cannot do these):** (a) browser sign-in at `https://localhost:8443` (accept the internal-cert warning; sign in with an allowlisted Google account); (b) on-box agent auth — `docker compose exec ao gh auth login` and `claude setup-token`. Note the redirect_uri / consent-screen gotchas.
  - **Teardown:** `down` (or `down --wipe`).
  - Note it embeds no secrets — only the project id (default `cloudbet-native`, override `--project`).

- [ ] **Step 2: Sanity-check** the frontmatter parses (matches `skills/bug-triage/SKILL.md` shape) and links to the design doc.

- [ ] **Step 3: Commit** (`feat(skill): valhalla-dev-bot SKILL.md`).

---

## Task 5: End-to-end skill verification

- [ ] **Step 1: Unit tests green** — `node --test skills/valhalla-dev-bot/lib.test.mjs`.
- [ ] **Step 2: Dry the documented flow** exactly as a user would, against `cloudbet-native`: `preflight` → `check` → `up` → `verify` → `down`, confirming the verify table matches today's manual run (302s, healthz, real client_id).
- [ ] **Step 3: Confirm no secret values are printed** anywhere in the run output (grep the captured output for the known client-id suffix / token shapes → none).
- [ ] **Step 4: Commit** any fixes.

---

## Done criteria

- `skills/valhalla-dev-bot/` contains `SKILL.md`, `run.mjs`, `lib.mjs`, `lib.test.mjs`.
- Unit tests pass; `run.mjs` subcommands work against the real `cloudbet-native` project.
- The full `preflight→check→up→verify→down` cycle reproduces the validated live result.
- Robust gcloud reader (file-redirect + non-empty assertion) is used; no secret values are ever printed.
- SKILL.md documents the 3-gate-secret + on-box-agent-auth model and the human-guided sign-in/agent-auth steps.

## Out of scope

- The "Connect GitHub/Claude" admin login-button (M5 polish); allowlist editor; M7 VM provisioning + SA/impersonation wiring (the skill uses the operator's own gcloud creds for the local alpha). The SA-impersonation path from the design doc is a Phase-2 addition.
