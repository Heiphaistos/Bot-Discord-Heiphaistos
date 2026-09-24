import { config } from '../config.js';
import { logger } from '../core/logger.js';
import { openDatabase } from '../core/database.js';
import { loadModules } from '../core/loader.js';
import { createContext } from '../core/context.js';
import { createClient } from '../core/client.js';
import { deployCommands } from '../core/deploy.js';

const force = process.argv.includes('--force');
const globalFlag = process.argv.includes('--global');
const db = openDatabase();
const modules = await loadModules({ logger });
const ctx = createContext({ client: createClient(), db, modules });
const res = await deployCommands(ctx, { force: true, guildId: globalFlag ? '' : config.discord.devGuildId });
logger.info({ module: 'deploy' }, `Terminé: ${res.count} commandes${force ? ' (forcé)' : ''}`);
db.close();
process.exit(0);
