// Co-located admin backend. Binds 0.0.0.0:AO_ADMIN_PORT (compose-net only);
// Caddy gates /admin/api/* with Google auth before it reaches here.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chooseSource, secretNames } from "../scripts/resolve-secrets.mjs";
import { buildAddVersionRequest, isValidSecret } from "./secrets-writer.mjs";

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.AO_ADMIN_PORT || 8090);
const REPO = process.env.AO_RELEASES_REPO || "ComposioHQ/agent-orchestrator";

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}
async function readBody(req) {
  let s = ""; for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}
async function gcpToken() {
  if (process.env.AO_GCP_ACCESS_TOKEN) return process.env.AO_GCP_ACCESS_TOKEN;
  try {
    const { stdout } = await execFileAsync("gcloud", ["auth", "print-access-token"], { timeout: 15000 });
    if (stdout.trim()) return stdout.trim();
  } catch { /* fall through */ }
  const r = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    { headers: { "Metadata-Flavor": "Google" } });
  if (!r.ok) throw new Error("no GCP token available");
  return (await r.json()).access_token;
}

async function getVersion() {
  let running = "unknown";
  try { const { stdout } = await execFileAsync("ao", ["--version"], { timeout: 10000 }); running = stdout.trim(); } catch {}
  let latest = null;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: { "accept": "application/vnd.github+json", "user-agent": "ao-admin" } });
    if (r.ok) latest = (await r.json()).tag_name || null;
  } catch {}
  // Normalize the release tag (strip a leading "v") before the substring check,
  // since `ao --version` may print the bare number while the tag is "vX.Y.Z".
  const normLatest = latest ? latest.replace(/^v/, "") : null;
  const updateAvailable = normLatest && !running.includes(normLatest) ? true : (latest ? false : null);
  return { running, latest, updateAvailable };
}

async function triggerUpdate() {
  const token = process.env.WATCHTOWER_TOKEN || "changeme-local";
  // Watchtower's /v1/update requires POST + Bearer (a GET is rejected).
  const r = await fetch("http://watchtower:8080/v1/update",
    { method: "POST", headers: { "Authorization": `Bearer ${token}` } });
  return { status: r.status, ok: r.ok };
}

async function rotateSecret(body) {
  const { secret, value } = body || {};
  if (!isValidSecret(secret)) { const e = new Error(`unknown secret (valid: ${secretNames().join(", ")})`); e.code = 400; throw e; }
  if (chooseSource(process.env) !== "gcp") { const e = new Error("rotation requires the gcp secret source (AO_GCP_PROJECT)"); e.code = 400; throw e; }
  const project = process.env.AO_GCP_PROJECT;
  const { url, body: reqBody } = buildAddVersionRequest(project, secret, value);
  const token = await gcpToken();
  const r = await fetch(url, { method: "POST", headers: { "Authorization": `Bearer ${token}`, "content-type": "application/json" }, body: reqBody });
  if (!r.ok) { const e = new Error(`Secret Manager addVersion failed: HTTP ${r.status}`); e.code = 502; throw e; }
  const j = await r.json();
  return { secret, version: j.name || null, note: "applies on next restart" };
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/admin/api/version") return send(res, 200, await getVersion());
    if (req.method === "POST" && url.pathname === "/admin/api/update") return send(res, 200, await triggerUpdate());
    if (req.method === "POST" && url.pathname === "/admin/api/secrets") return send(res, 200, await rotateSecret(await readBody(req)));
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, e.code || 500, { error: String(e.message || e) });
  }
}).listen(PORT, "0.0.0.0", () => console.log(`[admin] listening on :${PORT}`));
