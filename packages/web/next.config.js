import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootPkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8"));

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@composio/ao-core"],
  serverExternalPackages: ["@composio/core"],
  env: {
    AO_VERSION: rootPkg.version,
  },
};

export default nextConfig;
