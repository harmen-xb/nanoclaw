import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_ONLY', 'TEAMS_APP_ID', 'TEAMS_APP_SECRET', 'TEAMS_PORT', 'TEAMS_TENANT_ID', 'CLOUDFLARE_TUNNEL_NAME', 'CLOUDFLARE_TUNNEL_ID', 'CLOUDFLARE_TUNNEL_DOMAIN', 'CLOUDFLARE_TUNNEL_SUBDOMAIN']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_ONLY =
  (process.env.TELEGRAM_ONLY || envConfig.TELEGRAM_ONLY) === 'true';
export const TEAMS_APP_ID =
  process.env.TEAMS_APP_ID || envConfig.TEAMS_APP_ID || '';
export const TEAMS_APP_SECRET =
  process.env.TEAMS_APP_SECRET || envConfig.TEAMS_APP_SECRET || '';
export const TEAMS_PORT = parseInt(
  process.env.TEAMS_PORT || envConfig.TEAMS_PORT || '3978', 10
);
export const TEAMS_TENANT_ID =
  process.env.TEAMS_TENANT_ID || envConfig.TEAMS_TENANT_ID || '';
export const CLOUDFLARE_TUNNEL_NAME =
  process.env.CLOUDFLARE_TUNNEL_NAME || envConfig.CLOUDFLARE_TUNNEL_NAME || '';
export const CLOUDFLARE_TUNNEL_ID =
  process.env.CLOUDFLARE_TUNNEL_ID || envConfig.CLOUDFLARE_TUNNEL_ID || '';
export const CLOUDFLARE_TUNNEL_DOMAIN =
  process.env.CLOUDFLARE_TUNNEL_DOMAIN || envConfig.CLOUDFLARE_TUNNEL_DOMAIN || '';
export const CLOUDFLARE_TUNNEL_SUBDOMAIN =
  process.env.CLOUDFLARE_TUNNEL_SUBDOMAIN || envConfig.CLOUDFLARE_TUNNEL_SUBDOMAIN || '';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
