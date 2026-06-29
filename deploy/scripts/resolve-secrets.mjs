// Pure secret-source resolution + env mapping for the AO container entrypoint.
// I/O (the actual Secret Manager fetch) lives in entrypoint.sh, not here.

export const SECRET_ENV_MAP = {
  "claude-oauth-token": "CLAUDE_CODE_OAUTH_TOKEN",
  // GITHUB_TOKEN covers both the Go daemon (AO_GITHUB_TOKEN/GITHUB_TOKEN) and gh.
  "github-pat": "GITHUB_TOKEN",
  // Not consumed by the Go build yet (no Linear adapter); mapped for forward-compat.
  "linear-api-key": "LINEAR_API_KEY",
};

export function secretNames() {
  return Object.keys(SECRET_ENV_MAP);
}

/**
 * Decide the secret source. Explicit AO_SECRET_SOURCE wins; otherwise infer.
 * @param {Record<string,string|undefined>} env
 * @returns {"env"|"gcp"}
 */
export function chooseSource(env) {
  const explicit = env.AO_SECRET_SOURCE;
  if (explicit) {
    if (explicit !== "env" && explicit !== "gcp") {
      throw new Error(`AO_SECRET_SOURCE must be 'env' or 'gcp', got '${explicit}'`);
    }
    return explicit;
  }
  return env.AO_GCP_PROJECT ? "gcp" : "env";
}

// When invoked directly, print the resolved plan as shell-evalable lines so
// entrypoint.sh can consume it: `SOURCE=gcp` then one `MAP <secret> <ENV>` per line.
if (import.meta.url === `file://${process.argv[1]}`) {
  const source = chooseSource(process.env);
  process.stdout.write(`SOURCE=${source}\n`);
  for (const name of secretNames()) {
    process.stdout.write(`MAP ${name} ${SECRET_ENV_MAP[name]}\n`);
  }
}
