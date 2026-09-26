import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Directory that holds the running bundle.
 * In development that is `<repo>/dist`; in the packaged folder it is `<pkg>/app`.
 */
export const appDir = here;
export const parentDir = path.resolve(here, '..');

/**
 * Data lives next to `app/` in the packaged layout, and inside `dist/` in dev.
 * Override with QQAIBOT_DATA_DIR.
 */
export const dataDir = process.env.QQAIBOT_DATA_DIR
  ? path.resolve(process.env.QQAIBOT_DATA_DIR)
  : path.basename(here) === 'app'
    ? path.join(parentDir, 'data')
    : path.join(here, 'data');

export const logsDir = path.join(dataDir, 'logs');
export const mediaDir = path.join(dataDir, 'media');
export const dbFile = path.join(dataDir, 'bot.db');

/** First existing candidate, preferring the app dir over its parent. */
function pick(name: string): string {
  const local = path.join(appDir, name);
  if (existsSync(local)) return local;
  return path.join(parentDir, name);
}

export const configFile = pick('config.yaml');
export const envFile = pick('.env');
export const publicDir = pick('public');
export const exampleConfigFile = pick('config.example.yaml');
