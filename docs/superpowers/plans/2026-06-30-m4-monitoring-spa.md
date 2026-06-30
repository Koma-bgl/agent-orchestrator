# M4 — Monitoring SPA (sessions + live status) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A no-build static single-page UI, served by Caddy behind the existing Google-auth gate, that shows the AO daemon's sessions grouped by project with live-updating derived status — using `GET /api/v1/sessions` + the SSE `/api/v1/events` stream.

**Architecture:** No new container or backend. Caddy serves the static SPA for non-API routes and proxies `/api/*` (incl. SSE) + `/auth/*` to the daemon/portal — all behind the M3 auth gate. The SPA fetches sessions on load, opens an `EventSource` on `/api/v1/events`, and re-fetches on any event (SSE as a "something changed" signal, no CDC-schema parsing), with a polling fallback if the stream drops.

**Tech Stack:** Plain HTML + vanilla JS (`fetch`, `EventSource`) + inline CSS. No build step, no node_modules. Caddy `file_server`.

> **Scope (M4, local):** read-only sessions + live status, grouped by project. NOT in scope: projects/notifications panels, per-session drill-in (later), admin ops (M5), Watchtower (M6), VM/skill (M7–M8).

> **Verification reality:** the SPA is auth-gated by Caddy, so the no-Google mechanics tier verifies (a) the static SPA is served behind the gate (unauth → 302), (b) the daemon data contract the SPA depends on (`/api/v1/sessions` shape + SSE emits on session spawn). The rendered, authenticated UI is the operator's full-login tier (real Google client), documented in the README.

---

### Grounding facts (verified)

- M3 done: custom Caddy (`caddy-security`, Caddy 2.11.4) terminates TLS at `https://localhost:8443`, runs the Google portal, and proxies authenticated traffic to `ao:8080` (socat → daemon `127.0.0.1:3001`). The Caddyfile currently has `route /auth*` (portal) + `route /*` (authorize + reverse_proxy ao:8080).
- `GET /api/v1/sessions` → `{"sessions":[{id, projectId, kind, harness, activity:{state,lastActivityAt}, isTerminated, createdAt, updatedAt, status, branch, prs:[]}]}` (verified live in M1/flow-check).
- Derived `status` values: `working, idle, needs_input, pr_open, draft, ci_failed, changes_requested, review_pending, approved, mergeable, merge_conflict, merged, terminated, no_signal`.
- `GET /api/v1/events` is an SSE stream (Content-Type `text/event-stream`); `GET /api/v1/projects` lists projects.
- A worker session is created via `ao spawn --project <id>` (used for the SSE-emits test); `ao project add --path <repo>` registers a project. A throwaway git repo can be created in-container.
- Caddy `handle` blocks are mutually exclusive and order-evaluated — cleaner than `route` for path-splitting static vs proxy.

### File structure

- Create `deploy/web/index.html` — the entire SPA (inline CSS + JS).
- Modify `deploy/Caddyfile` — split routes: `/auth*` portal, `/api/*` proxy, else static `file_server` from `/srv` (all authorized).
- Modify `deploy/docker-compose.yml` — mount `./web:/srv:ro` into the `caddy` service.
- Modify `deploy/README.md` — note the dashboard URL + what it shows.

---

## Task 1: The SPA (static file)

**Files:**
- Create: `deploy/web/index.html`

- [ ] **Step 1: Write the SPA**

`deploy/web/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent Orchestrator</title>
<style>
  :root { color-scheme: light dark; --bg:#0f1115; --card:#181b22; --fg:#e6e8eb; --muted:#9aa3af; --line:#262b35; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:16px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:12px; }
  header h1 { font-size:15px; margin:0; font-weight:600; }
  #conn { font-size:12px; color:var(--muted); margin-left:auto; }
  #conn.live::before { content:"● "; color:#34d399; }
  #conn.down::before { content:"● "; color:#f87171; }
  main { padding:20px; max-width:1000px; margin:0 auto; }
  .project { margin-bottom:24px; }
  .project h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:0 0 8px; }
  .session { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-bottom:8px; display:flex; align-items:center; gap:12px; }
  .session .id { font-weight:600; }
  .session .meta { color:var(--muted); font-size:12px; }
  .session .branch { font-family:ui-monospace,monospace; font-size:12px; color:var(--muted); margin-left:auto; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; text-transform:lowercase; }
  .b-working,.b-approved,.b-mergeable { background:#064e3b; color:#6ee7b7; }
  .b-needs_input,.b-changes_requested,.b-ci_failed,.b-merge_conflict { background:#7f1d1d; color:#fca5a5; }
  .b-pr_open,.b-review_pending,.b-draft,.b-no_signal { background:#1e3a5f; color:#93c5fd; }
  .b-idle,.b-merged,.b-terminated { background:#33373f; color:var(--muted); }
  .empty,.error { color:var(--muted); padding:40px 0; text-align:center; }
  .error { color:#fca5a5; }
</style>
</head>
<body>
<header>
  <h1>Agent Orchestrator</h1>
  <span id="conn" class="down">connecting…</span>
</header>
<main id="app"><div class="empty">Loading…</div></main>
<script>
const app = document.getElementById("app");
const conn = document.getElementById("conn");
let refetchTimer = null;

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function badge(status) {
  const s = (status || "no_signal").replace(/[^a-z_]/gi, "");
  return `<span class="badge b-${s}">${s}</span>`;
}
function age(iso) {
  if (!iso) return "";
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return Math.floor(secs) + "s";
  if (secs < 3600) return Math.floor(secs / 60) + "m";
  if (secs < 86400) return Math.floor(secs / 3600) + "h";
  return Math.floor(secs / 86400) + "d";
}
function render(sessions) {
  if (!sessions.length) { app.innerHTML = '<div class="empty">No active sessions.</div>'; return; }
  const byProject = {};
  for (const s of sessions) (byProject[s.projectId] ||= []).push(s);
  app.innerHTML = Object.keys(byProject).sort().map(pid => `
    <section class="project">
      <h2>${esc(pid)}</h2>
      ${byProject[pid].map(s => `
        <div class="session">
          <span class="id">${esc(s.id)}</span>
          ${badge(s.status)}
          <span class="meta">${esc(s.harness)} · ${esc(s.kind)} · ${age(s.updatedAt || s.createdAt)}</span>
          <span class="branch">${esc(s.branch)}</span>
        </div>`).join("")}
    </section>`).join("");
}
async function refetch() {
  try {
    const r = await fetch("/api/v1/sessions", { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    render(data.sessions || []);
  } catch (e) {
    // A redirect to Google (expired session) surfaces as an opaque/fetch error.
    app.innerHTML = '<div class="error">Could not load sessions — your session may have expired. <a href="/" style="color:#93c5fd">Reload</a>.</div>';
  }
}
function debouncedRefetch() {
  clearTimeout(refetchTimer);
  refetchTimer = setTimeout(refetch, 250);
}
function connectSSE() {
  const es = new EventSource("/api/v1/events");
  es.onopen = () => { conn.className = "live"; conn.textContent = "live"; };
  es.onmessage = debouncedRefetch;
  es.onerror = () => {
    conn.className = "down"; conn.textContent = "reconnecting…";
    // EventSource auto-reconnects; nothing else needed.
  };
}
refetch();
connectSSE();
// Polling fallback in case SSE is unavailable.
setInterval(refetch, 15000);
</script>
</body>
</html>
```

- [ ] **Step 2: Sanity-check the HTML is well-formed**

Run: `node -e "const s=require('fs').readFileSync('deploy/web/index.html','utf8'); if(!s.includes('EventSource(\"/api/v1/events\")')||!s.includes('/api/v1/sessions')) throw new Error('missing core wiring'); console.log('SPA wiring OK')"`
Expected: `SPA wiring OK`.

- [ ] **Step 3: Commit**

```bash
git add deploy/web/index.html
git commit -m "feat(deploy): monitoring SPA — sessions + live status via SSE"
```

---

## Task 2: Caddyfile — serve the SPA, proxy the API

**Files:**
- Modify: `deploy/Caddyfile`

- [ ] **Step 1: Replace the site block's route handling**

Replace the existing site block (`{$AO_SITE_ADDRESS} { ... }`) body with `handle`-based path splitting:

```caddyfile
{$AO_SITE_ADDRESS} {
	# Local: Caddy internal self-signed cert. M7 removes `tls internal` for ACME.
	tls internal

	# Auth portal (login, OAuth callback) — unauthenticated by definition.
	handle /auth* {
		authenticate with myportal
	}

	# Daemon API (incl. SSE /api/v1/events) — authorized, proxied to the daemon.
	handle /api/* {
		authorize with mypolicy
		reverse_proxy ao:8080 {
			flush_interval -1
		}
	}

	# Everything else: the static monitoring SPA — also behind the auth gate.
	handle {
		authorize with mypolicy
		root * /srv
		file_server
	}
}
```

(Leave the global `{ ... }` block — `http_port`/`https_port`/`order`/`security` — unchanged.)

- [ ] **Step 2: Validate against the pinned image**

```bash
cd deploy
docker run --rm \
  -e GOOGLE_CLIENT_ID=dummy -e GOOGLE_CLIENT_SECRET=dummy \
  -e JWT_SHARED_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
  -e ALLOWED_EMAIL_1=test@example.com \
  -e AO_SITE_ADDRESS=localhost:8443 -e AO_SITE_URL=https://localhost:8443 \
  -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
  ao-caddy:dev caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -3
```
Expected: `Valid configuration`. If a `handle`/`file_server` keyword errors, fix per Caddy docs before proceeding.

- [ ] **Step 3: Commit**

```bash
git add deploy/Caddyfile
git commit -m "feat(deploy): Caddy serves the SPA, proxies /api behind the auth gate"
```

---

## Task 3: compose — mount the SPA into Caddy

**Files:**
- Modify: `deploy/docker-compose.yml`

- [ ] **Step 1: Mount `./web` at `/srv` (read-only) in the `caddy` service**

Add to the `caddy` service `volumes:` (alongside the Caddyfile + data mounts):

```yaml
      - ./web:/srv:ro
```

(M6/M7 note: for Watchtower-driven UI updates, the SPA should later be baked into the Caddy image instead of host-mounted — mounting is fine for local + the M7 repo-checkout VM.)

- [ ] **Step 2: Validate compose**

Run: `cd deploy && docker compose config >/dev/null && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add deploy/docker-compose.yml
git commit -m "feat(deploy): mount monitoring SPA into the caddy container"
```

---

## Task 4: README — dashboard section

**Files:**
- Modify: `deploy/README.md`

- [ ] **Step 1: Add an "M4: monitoring dashboard" note** under the M3 section:
  - After signing in (M3), `https://localhost:8443/` shows the live session dashboard.
  - It lists sessions grouped by project with a derived-status badge, updating live via SSE; a connection indicator shows live/reconnecting.
  - Read-only — it observes the daemon, it does not control it (admin ops are M5).

- [ ] **Step 1b: Refresh the stale top-of-file scope lines.** The README title (line 1, "M1–M2") and the early scope note predate M3/M4. Update them to reflect that M3 (auth) and M4 (dashboard) have landed, so the doc isn't self-contradicting.

- [ ] **Step 2: Commit**

```bash
git add deploy/README.md
git commit -m "docs(deploy): document the M4 monitoring dashboard"
```

---

## Task 5: Live verification

### 5a. Mechanics tier (controller-runnable, no Google client)

- [ ] **Step 1: Bring up the stack**

```bash
cd deploy
# .env from M3 mechanics tier (dummy Google creds, random JWT key) is fine.
docker compose up -d --build
sleep 10
docker compose ps   # ao healthy, caddy up
```

- [ ] **Step 2: SPA is served behind the gate (unauth → redirect)**

```bash
curl -sk -o /dev/null -w "GET / -> HTTP %{http_code}\n" https://localhost:8443/
curl -sk -i https://localhost:8443/ | grep -i '^location:'
```
Expected: `302`, `location:` pointing at `/auth/oauth2/google` — the SPA is gated, not served to anonymous users. (This confirms the `handle` ordering: `/` falls through to the authorized static handler.)

- [ ] **Step 3: The static file is actually present + correct in the container**

```bash
docker compose exec -T caddy sh -c 'head -5 /srv/index.html; grep -c "api/v1/events" /srv/index.html'
```
Expected: the SPA's `<!doctype html>` head + a non-zero grep count — proving the mount works and Caddy would serve our file (not the stock welcome page).

- [ ] **Step 4: Daemon data contract the SPA depends on — list + SSE-on-spawn**

Verify the endpoints the SPA consumes behave, exercised directly against the daemon (inside the container, bypassing the gate):

```bash
# (a) sessions list shape
docker compose exec -T ao curl -fsS http://127.0.0.1:3001/api/v1/sessions

# (b) SSE emits when a session is spawned: open the stream, spawn, watch for an event
docker compose exec -T ao sh -c '
  set -e
  git config --global user.email ao@example.com; git config --global user.name AO
  rm -rf /tmp/m4 && mkdir /tmp/m4 && cd /tmp/m4 && git init -q -b main
  echo hi > README.md && git add -A && git commit -qm init
  ao project add --path /tmp/m4 --worker-agent claude-code --name m4 >/dev/null
  ( timeout 8 curl -sN http://127.0.0.1:3001/api/v1/events & )
  sleep 1
  ao spawn --project m4 --harness claude-code --prompt hi >/dev/null
  sleep 3
  ao session ls
'
```
Expected: (a) returns `{"sessions":[...]}`. (b) **Hard gate:** the spawn produces a session in `ao session ls`. **Soft signal:** the backgrounded SSE curl prints at least one `data:`/event line — this is timing-sensitive (1s connect window, 3s drain) and may occasionally miss under arm64 emulation; treat a missed line as inconclusive, not a failure, as long as `ao session ls` shows the session. Clean up: `docker compose exec -T ao sh -c 'ao session kill m4-1 || true'`.

- [ ] **Step 5: Tear down**

```bash
docker compose down
```

### 5b. Full tier (operator, real Google client) — documented, deferred

- [ ] With a real `GOOGLE_CLIENT_ID/SECRET` + allowlisted `ALLOWED_EMAIL_1`, open `https://localhost:8443/`, sign in, and confirm: the dashboard lists sessions grouped by project with status badges; spawning/killing a session updates the UI live (the `conn` indicator reads "live"); a non-allowlisted account never reaches the SPA.

---

## Done criteria (M4, mechanics tier)

- `deploy/web/index.html` exists with the sessions + SSE wiring; HTML sanity check passes.
- Caddyfile validates with the `handle`-based split (`/auth*`, `/api/*`, static).
- `docker compose up` serves the SPA behind the auth gate: `GET /` → 302 to Google for anonymous users; the mounted `/srv/index.html` is our file.
- The daemon data contract holds: `/api/v1/sessions` returns the expected shape, and spawning a session emits on the SSE stream the SPA listens to.
- Full rendered+authenticated UI is documented for an operator with a real Google client (deferred, not blocking).
