#!/usr/bin/env node
// valhalla-dev-bot (alpha) — drive the local real-flow deploy test.
// Subcommands: preflight | check | up | verify | down
// Embeds NO secrets — only resolves the GCP project and reads the 3 gate secrets.
import { execFileSync } from "node:child_process";
import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { GATE_SECRETS, parseGoogleClient, buildEnv } from "./lib.mjs";

const DEPLOY_DIR = join(import.meta.dirname, "..", "..", "deploy");
const COMPOSE = ["compose", "-f", join(DEPLOY_DIR, "docker-compose.yml")];
const SITE = "https://localhost:8443";

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}
function ok(cmd, args) { try { run(cmd, args, { stdio: "ignore" }); return true; } catch { return false; } }
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
// HTTP status of a URL; returns "000" (never throws) when the connection fails —
// curl exits non-zero on connect/TLS errors but still writes the code to stdout.
function httpCode(url) {
  try { return run("curl", ["-sk", "-o", "/dev/null", "-w", "%{http_code}", url]).trim(); }
  catch (e) { return (e.stdout || "000").toString().trim(); }
}

function resolveProject() {
  if (process.env.AO_PROJECT) return process.env.AO_PROJECT;
  const argp = process.argv.find((a) => a.startsWith("--project="));
  if (argp) return argp.slice("--project=".length);
  return run("gcloud", ["config", "get-value", "project"]).trim();
}

// Robust read: shell `$(gcloud …)` intermittently returns empty; redirect stdout
// to a temp file, read it back, assert non-empty, retry once.
function readSecret(name, project) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tmp = join(mkdtempSync(join(tmpdir(), "vdb-")), name);
    try {
      const fd = openSync(tmp, "w");
      try {
        execFileSync("gcloud", ["secrets", "versions", "access", "latest", "--secret", name, "--project", project],
          { stdio: ["ignore", fd, "inherit"] });
      } finally { closeSync(fd); }
      const v = readFileSync(tmp, "utf8");
      if (v.length > 0) return v;
    } catch (e) { if (attempt === 1) throw e; }
    finally { try { unlinkSync(tmp); } catch {} }
  }
  throw new Error(`secret ${name}: empty value after retries`);
}

function preflight() {
  if (!ok("docker", ["info"])) { console.error("✗ docker is not running"); process.exit(1); }
  console.log("✓ docker running");
  const hasToken = !!process.env.AO_GCP_ACCESS_TOKEN || ok("gcloud", ["auth", "print-access-token"]);
  if (!hasToken) { console.error("✗ no GCP credential (set AO_GCP_ACCESS_TOKEN, run `gcloud auth login`, or ADC)"); process.exit(1); }
  console.log("✓ GCP credential available");
  const project = resolveProject();
  if (!project) { console.error("✗ no GCP project (pass --project= or `gcloud config set project`)"); process.exit(1); }
  console.log(`✓ project: ${project}  (override with --project=)`);
}

const CREATE_HINTS = {
  "google-oauth-client": "Console: OAuth Web client, redirect https://localhost:8443/auth/oauth2/google/authorization-code-callback; then: printf '%s' 'ID|SECRET' | gcloud secrets create google-oauth-client --data-file=-",
  "jwt-shared-key": "openssl rand -hex 32 | gcloud secrets create jwt-shared-key --data-file=-",
  "dashboard-allowlist": "printf '%s' you@org.com | gcloud secrets create dashboard-allowlist --data-file=-",
};
function check() {
  const project = resolveProject();
  let missing = 0;
  for (const s of GATE_SECRETS) {
    const exists = ok("gcloud", ["secrets", "describe", s, "--project", project]);
    console.log(`  ${exists ? "✓" : "✗"} ${s}`);
    if (!exists) { missing++; console.log(`      create: gcloud … --project=${project}  →  ${CREATE_HINTS[s]}`); }
  }
  if (missing) { console.error(`\n${missing} gate secret(s) missing — create them, then re-run.`); process.exit(1); }
  console.log("\nAll 3 gate secrets present. (Agent creds github/claude are on-box, not here.)");
}

function up() {
  const project = resolveProject();
  console.log(`Fetching gate secrets from ${project}…`);
  const { id, secret } = parseGoogleClient(readSecret("google-oauth-client", project));
  const jwt = readSecret("jwt-shared-key", project).trim();
  const allowlist = readSecret("dashboard-allowlist", project).trim();
  const env = buildEnv({ googleId: id, googleSecret: secret, jwt, allowlist, watchtowerToken: randomBytes(24).toString("hex") });
  writeFileSync(join(DEPLOY_DIR, ".env"), env);
  console.log(`Wrote deploy/.env (client_id ${id.length}c, secret ${secret.length}c, jwt ${jwt.length}c, allowlist ${allowlist.length}c) — gitignored.`);
  console.log("docker compose up -d --build …");
  run("docker", [...COMPOSE, "up", "-d", "--build"], { stdio: "inherit" });
}

function verify() {
  // up may have just rebuilt — wait for Caddy to answer before asserting.
  process.stdout.write("waiting for the stack to answer");
  for (let i = 0; i < 30; i++) { if (httpCode(`${SITE}/`) !== "000") break; process.stdout.write("."); sleep(2000); }
  console.log("");
  const checks = [];
  checks.push(["dashboard gated (/ → 302)", httpCode(`${SITE}/`) === "302"]);
  checks.push(["admin gated (/admin/api/version → 302)", httpCode(`${SITE}/admin/api/version`) === "302"]);
  checks.push(["daemon /healthz (in-container)", ok("docker", [...COMPOSE, "exec", "-T", "ao", "curl", "-fsS", "http://127.0.0.1:3001/healthz"])]);
  let realOauth = false;
  try {
    const loc = run("curl", ["-sk", "-i", `${SITE}/auth/oauth2/google`]).split("\n").find((l) => /^location:/i.test(l)) || "";
    realOauth = loc.includes("accounts.google.com") && /client_id=/.test(loc) && !/client_id=dummy/.test(loc);
  } catch {}
  checks.push(["real Google OAuth initiated (non-dummy client_id)", realOauth]);
  let allPass = true;
  for (const [name, pass] of checks) { console.log(`  ${pass ? "✓" : "✗"} ${name}`); if (!pass) allPass = false; }
  if (!allPass) { console.error("\nVerification FAILED."); process.exit(1); }
  console.log("\nAll checks passed. Sign in at https://localhost:8443 (allowlisted Google account) to use it live.");
}

function down() {
  const args = process.argv.includes("--wipe") ? ["down", "-v"] : ["down"];
  run("docker", [...COMPOSE, ...args], { stdio: "inherit" });
}

const cmd = process.argv[2];
const table = { preflight, check, up, verify, down };
if (!table[cmd]) { console.error("usage: run.mjs preflight|check|up|verify|down [--project=ID] [--wipe]"); process.exit(2); }
table[cmd]();
