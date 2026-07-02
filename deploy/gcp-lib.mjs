// Pure helpers for deploy-gcp.sh. No I/O. Also runnable as a CLI so bash can call:
//   node gcp-lib.mjs sslipHost 34.12.34.56   →   34-12-34-56.sslip.io
// Unit-tested in gcp-lib.test.mjs.

function sanitize(account) {
  return String(account)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")   // non-alnum → dash
    .replace(/-+/g, "-")             // collapse repeats
    .replace(/^-+|-+$/g, "");        // trim dashes
}

// GCE instance name: lowercase, [a-z0-9-], start with a letter, <= 63 chars.
// The "ao-" prefix guarantees a leading letter. Index 1 has no suffix (back-compat
// with single-VM deployments); index N >= 2 appends "-N".
export function vmName(account, index = 1) {
  const idx = Number(index) || 1;
  const suffix = idx > 1 ? `-${idx}` : "";
  const base = `ao-${sanitize(account)}`.slice(0, 63 - suffix.length).replace(/-+$/g, "");
  return `${base}${suffix}`;
}

// Reserved-IP name for a user's Nth VM (mirrors vmName indexing).
export function ipName(account, index = 1) {
  const idx = Number(index) || 1;
  const suffix = idx > 1 ? `-${idx}` : "";
  const base = `ao-${sanitize(account)}`.slice(0, 60 - suffix.length).replace(/-+$/g, "");
  return `${base}-ip${suffix}`;
}

// Per-user VM quota from a central JSON doc (the ao-vm-quotas secret):
//   {"default": 1, "ky@chaostheory.hk": 3}
// Missing doc / invalid JSON / absent keys all fall back to 1.
export function quotaFor(quotasJson, account) {
  try {
    const q = JSON.parse(quotasJson);
    const v = q?.[account] ?? q?.default ?? 1;
    return Number.isInteger(v) && v > 0 ? v : 1;
  } catch {
    return 1;
  }
}

// Label values: [a-z0-9_-], <= 63 chars.
export function ownerLabel(account) {
  return sanitize(account).slice(0, 63).replace(/-+$/g, "");
}

// sslip.io resolves a dashed (or dotted) IP hostname back to that IP.
export function sslipHost(ip) {
  return `${String(ip).trim().replace(/\./g, "-")}.sslip.io`;
}

export function redirectUri(host) {
  return `https://${host}/auth/oauth2/google/authorization-code-callback`;
}

// CLI tail: `node gcp-lib.mjs <fn> <arg> [<arg2>]`
const fns = { vmName, ownerLabel, sslipHost, redirectUri, ipName, quotaFor };
const [, , fn, arg, arg2] = process.argv;
if (fn) {
  if (!fns[fn]) { console.error(`unknown fn: ${fn}`); process.exit(2); }
  process.stdout.write(String(fns[fn](arg ?? "", arg2)));
}
