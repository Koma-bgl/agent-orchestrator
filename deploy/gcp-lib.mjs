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
// The "ao-" prefix guarantees a leading letter.
export function vmName(account) {
  const base = `ao-${sanitize(account)}`.slice(0, 63).replace(/-+$/g, "");
  return base;
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

// CLI tail: `node gcp-lib.mjs <fn> <arg>`
const fns = { vmName, ownerLabel, sslipHost, redirectUri };
const [, , fn, arg] = process.argv;
if (fn) {
  if (!fns[fn]) { console.error(`unknown fn: ${fn}`); process.exit(2); }
  process.stdout.write(fns[fn](arg ?? ""));
}
