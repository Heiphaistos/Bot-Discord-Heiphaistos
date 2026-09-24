/**
 * Erreurs et codes de sortie de la CLI heiphais.
 */
export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1, // erreur générique / action refusée par le bot
  USAGE: 2, // mauvaise utilisation de la CLI (arguments, commande inconnue)
  AUTH: 3, // 401 / 403 : jeton manquant, invalide ou insuffisant
  NOT_FOUND: 4, // 404 : serveur, module, action ou route introuvable
  NETWORK: 5, // panel injoignable
  SERVER: 6, // erreur 5xx côté bot
});

export class CliError extends Error {
  /**
   * @param {string} message message principal (français)
   * @param {object} [opts]
   * @param {number} [opts.exitCode]
   * @param {string|string[]} [opts.hint] conseil(s) affiché(s) sous l'erreur
   * @param {number} [opts.status] statut HTTP éventuel
   * @param {string} [opts.code] code d'erreur de l'API
   */
  constructor(message, { exitCode = EXIT.ERROR, hint = null, status = null, code = null } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.hint = hint;
    this.status = status;
    this.code = code;
  }
}

export const usageError = (message, hint = null) => new CliError(message, { exitCode: EXIT.USAGE, hint });
