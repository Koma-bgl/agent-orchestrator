// Pure request-building + validation for Secret Manager addVersion.
// The actual HTTP POST + token acquisition live in server.mjs.
import { SECRET_ENV_MAP } from "../scripts/resolve-secrets.mjs";

export function isValidSecret(name) {
  return Object.prototype.hasOwnProperty.call(SECRET_ENV_MAP, name);
}

/**
 * Build the Secret Manager :addVersion request for a secret.
 * @returns {{url:string, body:string}}
 */
export function buildAddVersionRequest(project, secret, value) {
  if (!isValidSecret(secret)) throw new Error(`unknown secret: ${secret}`);
  if (typeof value !== "string" || value.length === 0) throw new Error("empty value");
  const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${secret}:addVersion`;
  const body = JSON.stringify({ payload: { data: Buffer.from(value, "utf8").toString("base64") } });
  return { url, body };
}
