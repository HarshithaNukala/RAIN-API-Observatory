import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Same depth from src/ and dist/, so this resolves to the repository root in both.
const ROOT_ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));

/** Loads the repository-root .env if present. Real environment variables take precedence. */
export function loadDotEnv(): void {
  if (existsSync(ROOT_ENV_FILE)) process.loadEnvFile(ROOT_ENV_FILE);
}
