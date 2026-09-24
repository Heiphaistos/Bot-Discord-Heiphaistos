/**
 * Actions : administration de l'économie.
 */
import { ActionError } from '../../../core/actions.js';
import { embed, COLORS, truncate } from '../../../core/utils.js';
import { S, getEco, money, assertTarget, mention, ecoLog } from '../helpers.js';

const TARGET = { type: 'choice', description: 'Solde visé', choices: [{ name: 'Portefeuille', value: 'wallet' }, { name: 'Banque', value: 'bank' }], default: 'wallet' };
const REASON = { type: 'string', description: 'Motif', maxLength: 200 };
const LABEL = { wallet: 'portefeuille', bank: 'banque' };

async function log(ctx, guild, actor, text) {
  await ecoLog(ctx, guild, embed({ title: '🛠️ Administration économie', description: truncate(`${text}\nPar ${mention(actor.id)}`, 4000), color: COLORS.warning, timestamp: true }));
}

export const adminActions = {
  admin_add: {
    description: 'Ajouter de l\'argent à un membre', slash: { group: 'eco', subgroup: 'admin', name: 'add' },
    permissions: ['ManageGuild'],
    params: { user: { type: 'user', required: true, description: 'Membre' }, amount: { type: 'integer', required: true, description: 'Montant', min: 1, max: 1000000000000 }, target: TARGET, reason: REASON },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      await assertTarget(ctx, params.user, actor, { allowSelf: true });
      const acc = getEco(ctx).store.adjust(guild.id, params.user, params.amount, 'admin_add', { by: actor.id, reason: params.reason || null }, { field: params.target });
      await log(ctx, guild, actor, `+${money(s, params.amount)} (${LABEL[params.target]}) pour ${mention(params.user)}${params.reason ? ` — ${params.reason}` : ''}`);
      return { message: `${money(s, params.amount)} ajoutés au ${LABEL[params.target]} de ${mention(params.user)}. Nouveau solde : ${money(s, acc[params.target])}.`, data: { userId: params.user, wallet: acc.wallet, bank: acc.bank } };
    },
  },

  admin_remove: {
    description: 'Retirer de l\'argent à un membre', slash: { group: 'eco', subgroup: 'admin', name: 'remove' },
    permissions: ['ManageGuild'],
    params: { user: { type: 'user', required: true, description: 'Membre' }, amount: { type: 'integer', required: true, description: 'Montant (plafonné au solde)', min: 1, max: 1000000000000 }, target: TARGET, reason: REASON },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      const { store } = getEco(ctx);
      const cur = store.ensure(guild.id, params.user)[params.target];
      const amount = Math.min(cur, params.amount);
      if (amount <= 0) throw new ActionError(`Le ${LABEL[params.target]} de ce membre est déjà vide.`);
      const acc = store.adjust(guild.id, params.user, -amount, 'admin_remove', { by: actor.id, reason: params.reason || null }, { field: params.target });
      await log(ctx, guild, actor, `−${money(s, amount)} (${LABEL[params.target]}) pour ${mention(params.user)}${params.reason ? ` — ${params.reason}` : ''}`);
      return { message: `${money(s, amount)} retirés du ${LABEL[params.target]} de ${mention(params.user)}. Nouveau solde : ${money(s, acc[params.target])}.`, data: { userId: params.user, removed: amount, wallet: acc.wallet, bank: acc.bank } };
    },
  },

  admin_set: {
    description: 'Définir le solde d\'un membre', slash: { group: 'eco', subgroup: 'admin', name: 'set' },
    permissions: ['ManageGuild'],
    params: { user: { type: 'user', required: true, description: 'Membre' }, amount: { type: 'integer', required: true, description: 'Nouveau montant', min: 0, max: 1000000000000 }, target: TARGET, reason: REASON },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      await assertTarget(ctx, params.user, actor, { allowSelf: true });
      const acc = getEco(ctx).store.setBalance(guild.id, params.user, { [params.target]: params.amount }, 'admin_set', { by: actor.id, reason: params.reason || null });
      await log(ctx, guild, actor, `${LABEL[params.target]} de ${mention(params.user)} défini à ${money(s, params.amount)}${params.reason ? ` — ${params.reason}` : ''}`);
      return { message: `Le ${LABEL[params.target]} de ${mention(params.user)} est maintenant de ${money(s, params.amount)}.`, data: { userId: params.user, wallet: acc.wallet, bank: acc.bank } };
    },
  },

  admin_reset: {
    description: 'Réinitialiser le compte d\'un membre (solde, inventaire, actions)', slash: { group: 'eco', subgroup: 'admin', name: 'reset' },
    permissions: ['ManageGuild'],
    params: { user: { type: 'user', required: true, description: 'Membre' }, reason: REASON },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      const prev = getEco(ctx).store.resetAccount(guild.id, params.user, actor.id);
      await log(ctx, guild, actor, `Compte de ${mention(params.user)} réinitialisé${prev ? ` (avait ${money(s, prev.wallet + prev.bank)})` : ''}${params.reason ? ` — ${params.reason}` : ''}`);
      return { message: `Compte de ${mention(params.user)} réinitialisé. Il repartira avec ${money(s, s.startBalance)}.`, data: { userId: params.user, previous: prev } };
    },
  },

  admin_resetall: {
    description: 'Réinitialiser TOUTE l\'économie du serveur (irréversible)', slash: { group: 'eco', subgroup: 'admin', name: 'resetall' },
    permissions: ['Administrator'],
    params: { confirm: { type: 'boolean', required: true, description: 'Confirmer (true) — action irréversible' } },
    async run(ctx, { guild, actor, params }) {
      if (params.confirm !== true) throw new ActionError('Réinitialisation annulée : relancez avec `confirm: true` pour confirmer.');
      const s = S(ctx, guild.id);
      const r = getEco(ctx).store.resetAll(guild.id, actor.id);
      await log(ctx, guild, actor, `⚠️ Économie entièrement réinitialisée : ${r.n} compte(s), ${money(s, r.wallets + r.banks)} effacés.`);
      return { message: `Économie réinitialisée : ${r.n} compte(s) supprimé(s), inventaires, positions boursières, échanges et primes effacés. La boutique, la bourse et la trésorerie sont conservées.`, data: { accounts: r.n, wiped: r.wallets + r.banks } };
    },
  },
};
