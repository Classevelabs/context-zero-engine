/**
 * ContextZero — environment file loading.
 *
 * The MCP bridge is launched by a client that passes CONTEXTZERO_ENV_FILE
 * pointing at an install-specific .env, so that path is the whole configuration
 * for most installs.
 *
 * Both config modules previously loaded it with dotenv's `quiet` flag and
 * discarded the result, which meant a path that did not resolve produced no
 * error and no log line — the process simply came up with nothing configured.
 * The failure then surfaced wherever the first missing value was used, as
 * something like "SASL: client password must be a string", which names neither
 * the file nor the fact that it was never read. `npm run doctor` already
 * reports this case as a hard failure; the runtime now agrees with it.
 */

import * as dotenv from "dotenv"
import * as fs from "fs"

/**
 * Populate process.env from the configured .env file.
 *
 * An explicitly named file must exist: it was chosen deliberately, so a missing
 * one is a configuration error rather than a fallback to ambient environment.
 * With no CONTEXTZERO_ENV_FILE set, an absent .env stays permissible — the
 * values may legitimately come from the environment, as they do in Docker.
 */
export function loadEnvFile(): void {
  const explicitPath = process.env["CONTEXTZERO_ENV_FILE"]

  if (!explicitPath) {
    dotenv.config({ quiet: true })
    return
  }

  if (!fs.existsSync(explicitPath)) {
    throw new Error(
      `CONTEXTZERO_ENV_FILE points at ${explicitPath}, which does not exist. ` +
        `Nothing was loaded from it, so every setting it holds is unset. ` +
        `Correct the path or unset CONTEXTZERO_ENV_FILE to read the ambient environment.`,
    )
  }

  const result = dotenv.config({ path: explicitPath, quiet: true, override: true })
  if (result.error) {
    throw new Error(`CONTEXTZERO_ENV_FILE at ${explicitPath} could not be read: ${result.error.message}`)
  }
}
