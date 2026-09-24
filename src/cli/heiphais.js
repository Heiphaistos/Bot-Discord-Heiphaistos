#!/usr/bin/env node
/**
 * heiphais — CLI de HeiphaisBot.
 * Pilote le bot via l'API REST du panel (Authorization: Bearer hb_…) ; mode --local pour créer un jeton
 * directement dans la base SQLite. Aide : heiphais --help
 */
import { buildProgram } from './program.js';

process.env.DOTENV_CONFIG_QUIET ??= 'true';

// Sortie fermée par le lecteur (ex : heiphais actions | head) : on s'arrête silencieusement.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); throw err; });
}

const { program, rt } = buildProgram();
let code = 0;
try {
  await program.parseAsync(process.argv);
  code = process.exitCode ?? 0;
} catch (err) {
  code = rt.reportError(err);
}
// Vide les sorties avant de quitter (évite que des connexions keep-alive retiennent le processus).
await new Promise((resolve) => process.stdout.write('', resolve));
await new Promise((resolve) => process.stderr.write('', resolve));
process.exit(code);
