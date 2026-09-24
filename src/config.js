import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

function bool(v, def = false) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
function list(v) {
  return (v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

const dataDir = path.resolve(ROOT, process.env.DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  env: process.env.NODE_ENV || 'production',
  version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
  botName: process.env.BOT_NAME || 'HeiphaisBot',
  discord: {
    token: process.env.DISCORD_TOKEN || '',
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    devGuildId: process.env.DEV_GUILD_ID || '',
    autoDeployCommands: bool(process.env.AUTO_DEPLOY_COMMANDS, true),
    presenceIntent: bool(process.env.PRESENCE_INTENT, false),
    status: process.env.BOT_STATUS || 'online',
    activity: process.env.BOT_ACTIVITY || '/help | HeiphaisBot',
    activityType: process.env.BOT_ACTIVITY_TYPE || 'Playing',
  },
  ownerIds: list(process.env.OWNER_IDS),
  defaultPrefix: process.env.DEFAULT_PREFIX || '!',
  color: parseInt((process.env.EMBED_COLOR || '#5865F2').replace('#', ''), 16),
  dataDir,
  databasePath: process.env.DATABASE_PATH || path.join(dataDir, 'heiphaisbot.db'),
  logLevel: process.env.LOG_LEVEL || 'info',
  panel: {
    enabled: bool(process.env.PANEL_ENABLED, true),
    host: process.env.PANEL_HOST || '0.0.0.0',
    port: parseInt(process.env.PANEL_PORT || '3000', 10),
    publicUrl: (process.env.PANEL_PUBLIC_URL || `http://localhost:${process.env.PANEL_PORT || 3000}`).replace(/\/$/, ''),
    sessionSecret: process.env.PANEL_SESSION_SECRET || '',
    adminPassword: process.env.PANEL_ADMIN_PASSWORD || '',
    trustProxy: bool(process.env.PANEL_TRUST_PROXY, true),
    sessionTtlMs: 7 * 24 * 3600 * 1000,
  },
  integrations: {
    forgeArchive: {
      url: (process.env.FORGEARCHIVE_URL || '').replace(/\/$/, ''),
      apiKey: process.env.FORGEARCHIVE_API_KEY || '',
    },
    forgeHook: {
      url: (process.env.FORGEHOOK_URL || '').replace(/\/$/, ''),
      apiKey: process.env.FORGEHOOK_API_KEY || '',
      secret: process.env.FORGEHOOK_SECRET || '',
    },
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
  },
  music: {
    ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',
    maxQueue: parseInt(process.env.MUSIC_MAX_QUEUE || '200', 10),
  },
};

export function validateConfig({ requireToken = true } = {}) {
  const errors = [];
  if (requireToken && !config.discord.token) errors.push('DISCORD_TOKEN manquant');
  if (requireToken && !config.discord.clientId) errors.push('DISCORD_CLIENT_ID manquant');
  if (config.panel.enabled && !config.panel.sessionSecret) {
    errors.push('PANEL_SESSION_SECRET manquant (générez-le avec: openssl rand -hex 32)');
  }
  return errors;
}

export default config;
