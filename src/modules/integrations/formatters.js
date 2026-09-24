import { EmbedBuilder } from 'discord.js';
import crypto from 'node:crypto';
import { embed, truncate, renderTemplate, COLORS } from '../../core/utils.js';
import { hmacHex, safeEqual } from './outgoing.js';

export const FORMATS = ['generic', 'github', 'gitlab', 'stripe', 'paypal', 'trello', 'jira', 'uptimekuma', 'forgehook'];
export const FORMAT_CHOICES = [
  { name: 'Générique (JSON / modèle)', value: 'generic' }, { name: 'GitHub', value: 'github' }, { name: 'GitLab', value: 'gitlab' },
  { name: 'Stripe', value: 'stripe' }, { name: 'PayPal', value: 'paypal' }, { name: 'Trello', value: 'trello' }, { name: 'Jira', value: 'jira' },
  { name: 'Uptime Kuma', value: 'uptimekuma' }, { name: 'ForgeHook', value: 'forgehook' },
];

const GH = 0x24292f; const GL = 0xfc6d26; const STRIPE = 0x635bff; const PAYPAL = 0x003087; const TRELLO = 0x0079bf; const JIRA = 0x0052cc;
const firstLine = (s) => String(s || '').split('\n')[0];
const h = (headers, name) => { const v = headers?.[name.toLowerCase()]; return Array.isArray(v) ? v[0] : v; };

/**
 * Format an incoming payload into a Discord message payload.
 * @returns {{ embeds?: EmbedBuilder[], content?: string } | null} null = event ignored
 */
export function formatIncoming(format, { body, headers = {}, query = {}, template = null }) {
  if (template && format === 'generic') return formatTemplate(template, { body, headers, query });
  switch (format) {
    case 'github': return formatGitHub(h(headers, 'x-github-event') || guessGitHubEvent(body), body);
    case 'gitlab': return formatGitLab(h(headers, 'x-gitlab-event'), body);
    case 'stripe': return formatStripe(body);
    case 'paypal': return formatPayPal(body);
    case 'trello': return formatTrello(body);
    case 'jira': return formatJira(body);
    case 'uptimekuma': return formatUptimeKuma(body);
    case 'forgehook': return formatForgeHook(body, headers);
    default: return template ? formatTemplate(template, { body, headers, query }) : formatGeneric(body);
  }
}

/* ------------------------------ GitHub ------------------------------ */

function guessGitHubEvent(b) {
  if (b?.commits && b?.ref) return 'push';
  if (b?.pull_request) return 'pull_request';
  if (b?.issue && b?.comment) return 'issue_comment';
  if (b?.issue) return 'issues';
  if (b?.release) return 'release';
  if (b?.workflow_run) return 'workflow_run';
  if (b?.forkee) return 'fork';
  if (b?.zen) return 'ping';
  return 'unknown';
}

function ghAuthor(b) {
  const s = b?.sender;
  return s ? { name: s.login, iconURL: s.avatar_url, url: s.html_url } : undefined;
}

export function formatGitHub(event, b = {}) {
  const repo = b.repository?.full_name || '?';
  const author = ghAuthor(b);
  const action = b.action;
  switch (event) {
    case 'ping':
      return { embeds: [embed({ color: GH, author, title: `🔗 Webhook GitHub connecté : ${repo}`, description: b.zen ? `*${b.zen}*` : undefined })] };
    case 'push': {
      const branch = String(b.ref || '').replace(/^refs\/(heads|tags)\//, '');
      if (b.deleted) return { embeds: [embed({ color: COLORS.error, author, title: `[${repo}] branche supprimée : ${branch}` })] };
      const commits = b.commits || [];
      if (!commits.length) return b.created ? { embeds: [embed({ color: GH, author, title: `[${repo}] nouvelle ${String(b.ref).startsWith('refs/tags/') ? 'étiquette' : 'branche'} : ${branch}`, url: b.compare })] } : null;
      const lines = commits.slice(0, 10).map((c) => `[\`${String(c.id).slice(0, 7)}\`](${c.url}) ${truncate(firstLine(c.message), 70)} — ${c.author?.username || c.author?.name || '?'}`);
      if (commits.length > 10) lines.push(`… et ${commits.length - 10} autre(s)`);
      return { embeds: [embed({ color: GH, author, title: `[${repo}:${branch}] ${commits.length} nouveau${commits.length > 1 ? 'x' : ''} commit${commits.length > 1 ? 's' : ''}${b.forced ? ' (forcé)' : ''}`, url: b.compare, description: lines.join('\n') })] };
    }
    case 'pull_request': {
      const pr = b.pull_request || {};
      const map = { opened: ['🟢 Pull request ouverte', COLORS.success], reopened: ['🔄 Pull request rouverte', COLORS.success], ready_for_review: ['👀 Pull request prête pour relecture', COLORS.info], closed: pr.merged ? ['🟣 Pull request fusionnée', 0x8957e5] : ['🔴 Pull request fermée', COLORS.error] };
      const m = map[action];
      if (!m) return null;
      return { embeds: [embed({ color: m[1], author, title: `[${repo}] ${m[0]} #${pr.number} : ${pr.title}`, url: pr.html_url, description: action === 'opened' ? truncate(pr.body || '', 500) : undefined, fields: [{ name: 'Branches', value: `\`${pr.head?.ref || '?'}\` → \`${pr.base?.ref || '?'}\``, inline: true }, ...(action === 'opened' ? [{ name: 'Modifications', value: `+${pr.additions ?? '?'} / -${pr.deletions ?? '?'} (${pr.changed_files ?? '?'} fichiers)`, inline: true }] : [])] })] };
    }
    case 'issues': {
      const i = b.issue || {};
      const map = { opened: ['🟢 Issue ouverte', COLORS.success], closed: ['🔴 Issue fermée', COLORS.error], reopened: ['🔄 Issue rouverte', COLORS.success] };
      const m = map[action];
      if (!m) return null;
      return { embeds: [embed({ color: m[1], author, title: `[${repo}] ${m[0]} #${i.number} : ${i.title}`, url: i.html_url, description: action === 'opened' ? truncate(i.body || '', 500) : undefined, fields: i.labels?.length ? [{ name: 'Étiquettes', value: i.labels.map((l) => `\`${l.name}\``).join(' '), inline: true }] : [] })] };
    }
    case 'issue_comment': {
      if (action !== 'created') return null;
      const i = b.issue || {};
      return { embeds: [embed({ color: GH, author, title: `[${repo}] 💬 Commentaire sur #${i.number} : ${i.title}`, url: b.comment?.html_url, description: truncate(b.comment?.body || '', 800) })] };
    }
    case 'release': {
      if (!['published', 'released', 'prereleased'].includes(action)) return null;
      const r = b.release || {};
      return { embeds: [embed({ color: COLORS.success, author, title: `[${repo}] 🚀 Nouvelle version : ${r.name || r.tag_name}`, url: r.html_url, description: truncate(r.body || '', 1500), fields: [{ name: 'Étiquette', value: `\`${r.tag_name}\``, inline: true }, ...(r.prerelease ? [{ name: 'Type', value: 'Pré-version', inline: true }] : [])] })] };
    }
    case 'star':
    case 'watch': {
      if (!['created', 'started'].includes(action)) return null;
      return { embeds: [embed({ color: 0xe3b341, author, title: `[${repo}] ⭐ Nouvelle étoile`, url: b.repository?.html_url, description: `Total : **${b.repository?.stargazers_count ?? '?'}** étoiles` })] };
    }
    case 'fork':
      return { embeds: [embed({ color: GH, author, title: `[${repo}] 🍴 Nouveau fork : ${b.forkee?.full_name}`, url: b.forkee?.html_url, description: `Total : **${b.repository?.forks_count ?? '?'}** forks` })] };
    case 'workflow_run': {
      const w = b.workflow_run || {};
      if (action !== 'completed') return null;
      const ok = w.conclusion === 'success';
      const label = { success: '✅ réussi', failure: '❌ échoué', cancelled: '⚪ annulé', timed_out: '⏱️ expiré', skipped: '⏭️ ignoré' }[w.conclusion] || w.conclusion;
      return { embeds: [embed({ color: ok ? COLORS.success : (w.conclusion === 'failure' ? COLORS.error : COLORS.neutral), author, title: `[${repo}] Workflow « ${w.name} » ${label}`, url: w.html_url, fields: [{ name: 'Branche', value: `\`${w.head_branch || '?'}\``, inline: true }, { name: 'Commit', value: `\`${String(w.head_sha || '').slice(0, 7)}\` ${truncate(firstLine(w.head_commit?.message), 60)}`, inline: true }, { name: 'Déclencheur', value: w.event || '?', inline: true }] })] };
    }
    case 'create':
    case 'delete':
      return { embeds: [embed({ color: event === 'create' ? COLORS.success : COLORS.error, author, title: `[${repo}] ${b.ref_type === 'tag' ? 'Étiquette' : 'Branche'} ${event === 'create' ? 'créée' : 'supprimée'} : ${b.ref}` })] };
    default:
      return { embeds: [embed({ color: GH, author, title: `[${repo}] Évènement GitHub : ${event}${action ? ` (${action})` : ''}`, url: b.repository?.html_url })] };
  }
}

/* ------------------------------ GitLab ------------------------------ */

export function formatGitLab(eventHeader, b = {}) {
  const kind = b.object_kind || String(eventHeader || '').toLowerCase().replace(/ hook$/, '').replace(/ /g, '_');
  const project = b.project?.path_with_namespace || b.project?.name || '?';
  const user = b.user ? { name: b.user.username || b.user.name, iconURL: b.user.avatar_url } : (b.user_username ? { name: b.user_username, iconURL: b.user_avatar } : undefined);
  switch (kind) {
    case 'push':
    case 'tag_push': {
      const ref = String(b.ref || '').replace(/^refs\/(heads|tags)\//, '');
      if (kind === 'tag_push') return { embeds: [embed({ color: GL, author: user, title: `[${project}] 🏷️ Étiquette ${b.after && /^0+$/.test(b.after) ? 'supprimée' : 'poussée'} : ${ref}`, url: b.project?.web_url })] };
      const commits = b.commits || [];
      if (!commits.length) return null;
      const lines = commits.slice(0, 10).map((c) => `[\`${String(c.id).slice(0, 8)}\`](${c.url}) ${truncate(firstLine(c.message || c.title), 70)} — ${c.author?.name || '?'}`);
      if ((b.total_commits_count || commits.length) > 10) lines.push(`… et ${(b.total_commits_count || commits.length) - 10} autre(s)`);
      return { embeds: [embed({ color: GL, author: user, title: `[${project}:${ref}] ${b.total_commits_count || commits.length} nouveau(x) commit(s)`, url: b.project?.web_url ? `${b.project.web_url}/-/commits/${ref}` : undefined, description: lines.join('\n') })] };
    }
    case 'merge_request': {
      const mr = b.object_attributes || {};
      const map = { open: ['🟢 Merge request ouverte', COLORS.success], reopen: ['🔄 Merge request rouverte', COLORS.success], close: ['🔴 Merge request fermée', COLORS.error], merge: ['🟣 Merge request fusionnée', 0x8957e5], approved: ['✅ Merge request approuvée', COLORS.success] };
      const m = map[mr.action];
      if (!m) return null;
      return { embeds: [embed({ color: m[1], author: user, title: `[${project}] ${m[0]} !${mr.iid} : ${mr.title}`, url: mr.url, description: mr.action === 'open' ? truncate(mr.description || '', 500) : undefined, fields: [{ name: 'Branches', value: `\`${mr.source_branch}\` → \`${mr.target_branch}\``, inline: true }] })] };
    }
    case 'issue': {
      const i = b.object_attributes || {};
      const map = { open: ['🟢 Issue ouverte', COLORS.success], close: ['🔴 Issue fermée', COLORS.error], reopen: ['🔄 Issue rouverte', COLORS.success] };
      const m = map[i.action];
      if (!m) return null;
      return { embeds: [embed({ color: m[1], author: user, title: `[${project}] ${m[0]} #${i.iid} : ${i.title}`, url: i.url, description: i.action === 'open' ? truncate(i.description || '', 500) : undefined })] };
    }
    case 'note': {
      const n = b.object_attributes || {};
      return { embeds: [embed({ color: GL, author: user, title: `[${project}] 💬 Commentaire (${n.noteable_type || 'note'})`, url: n.url, description: truncate(n.note || '', 800) })] };
    }
    case 'pipeline': {
      const p = b.object_attributes || {};
      const labels = { success: ['✅ réussi', COLORS.success], failed: ['❌ échoué', COLORS.error], canceled: ['⚪ annulé', COLORS.neutral], skipped: ['⏭️ ignoré', COLORS.neutral] };
      const l = labels[p.status];
      if (!l) return null;
      return { embeds: [embed({ color: l[1], author: user, title: `[${project}] Pipeline #${p.id} ${l[0]}`, url: b.project?.web_url ? `${b.project.web_url}/-/pipelines/${p.id}` : undefined, fields: [{ name: 'Branche', value: `\`${p.ref || '?'}\``, inline: true }, { name: 'Durée', value: p.duration ? `${p.duration}s` : '—', inline: true }, { name: 'Commit', value: truncate(firstLine(b.commit?.message) || String(p.sha || '').slice(0, 8), 100), inline: true }] })] };
    }
    case 'release': {
      if (b.action && b.action !== 'create') return null;
      return { embeds: [embed({ color: COLORS.success, author: user, title: `[${project}] 🚀 Nouvelle version : ${b.name || b.tag}`, url: b.url, description: truncate(b.description || '', 1500) })] };
    }
    default:
      return { embeds: [embed({ color: GL, author: user, title: `[${project}] Évènement GitLab : ${kind || 'inconnu'}`, url: b.project?.web_url })] };
  }
}

/* ------------------------------ Stripe ------------------------------ */

const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);

export function formatMoney(amount, currency, { minorUnits = true } = {}) {
  if (amount === null || amount === undefined || amount === '') return '—';
  const cur = String(currency || 'eur').toUpperCase();
  let value = Number(amount);
  if (minorUnits && !ZERO_DECIMAL.has(cur.toLowerCase())) value /= 100;
  try { return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: cur }).format(value); } catch { return `${value} ${cur}`; }
}

export function formatStripe(b = {}) {
  const type = b.type || '?';
  const o = b.data?.object || {};
  const live = b.livemode ? '' : ' (mode test)';
  const customer = o.customer_details?.email || o.customer_email || o.receipt_email || o.billing_details?.email || o.customer_details?.name || (typeof o.customer === 'string' ? o.customer : o.customer?.email) || '—';
  const base = (title, color, amountLabel, amount, extra = []) => ({ embeds: [embed({ color, title: `${title}${live}`, fields: [{ name: amountLabel, value: amount, inline: true }, { name: 'Client', value: truncate(String(customer), 1024), inline: true }, ...extra], footer: `Stripe • ${type} • ${o.id || b.id || ''}`, timestamp: b.created ? b.created * 1000 : true })] });
  switch (type) {
    case 'payment_intent.succeeded':
      return base('💳 Paiement réussi', COLORS.success, 'Montant', formatMoney(o.amount_received ?? o.amount, o.currency), o.description ? [{ name: 'Description', value: truncate(o.description, 1024) }] : []);
    case 'payment_intent.payment_failed':
      return base('⚠️ Paiement échoué', COLORS.error, 'Montant', formatMoney(o.amount, o.currency), [{ name: 'Raison', value: truncate(o.last_payment_error?.message || '—', 1024) }]);
    case 'checkout.session.completed':
      return base('🛒 Commande validée', COLORS.success, 'Total', formatMoney(o.amount_total, o.currency), [{ name: 'Mode', value: o.mode || '—', inline: true }, { name: 'Statut du paiement', value: o.payment_status || '—', inline: true }]);
    case 'charge.succeeded':
      return base('💳 Paiement encaissé', COLORS.success, 'Montant', formatMoney(o.amount, o.currency));
    case 'charge.refunded':
      return base('↩️ Remboursement', COLORS.warning, 'Montant remboursé', formatMoney(o.amount_refunded, o.currency), [{ name: 'Montant initial', value: formatMoney(o.amount, o.currency), inline: true }]);
    case 'invoice.paid':
    case 'invoice.payment_succeeded':
      return base('🧾 Facture payée', COLORS.success, 'Montant', formatMoney(o.amount_paid, o.currency), o.hosted_invoice_url ? [{ name: 'Facture', value: `[Voir la facture](${o.hosted_invoice_url})`, inline: true }] : []);
    case 'invoice.payment_failed':
      return base('⚠️ Échec de paiement de facture', COLORS.error, 'Montant dû', formatMoney(o.amount_due, o.currency));
    default:
      if (type.startsWith('customer.subscription.')) {
        const item = o.items?.data?.[0];
        const price = item?.price || item?.plan || {};
        const interval = price.recurring?.interval || price.interval;
        const titles = { 'customer.subscription.created': ['🆕 Nouvel abonnement', COLORS.success], 'customer.subscription.updated': ['🔄 Abonnement modifié', COLORS.info], 'customer.subscription.deleted': ['❌ Abonnement résilié', COLORS.error], 'customer.subscription.paused': ['⏸️ Abonnement suspendu', COLORS.warning], 'customer.subscription.resumed': ['▶️ Abonnement repris', COLORS.success], 'customer.subscription.trial_will_end': ['⏳ Fin d\'essai proche', COLORS.warning] };
        const [title, color] = titles[type] || [`Abonnement : ${type.split('.').pop()}`, COLORS.info];
        const intervalFr = { day: 'jour', week: 'semaine', month: 'mois', year: 'an' }[interval] || interval;
        return base(`${title}`, color, 'Tarif', `${formatMoney(price.unit_amount ?? price.amount, price.currency || o.currency)}${intervalFr ? ` / ${intervalFr}` : ''}`, [{ name: 'Statut', value: o.status || '—', inline: true }]);
      }
      return { embeds: [embed({ color: STRIPE, title: `Stripe : ${type}${live}`, description: `\`\`\`json\n${truncate(JSON.stringify(o, null, 2), 1800)}\n\`\`\``, footer: `Stripe • ${b.id || ''}` })] };
  }
}

/* ------------------------------ PayPal ------------------------------ */

export function formatPayPal(b = {}) {
  if (b.txn_type || b.payment_status) {
    // Classic IPN (form-encoded)
    const donation = b.txn_type === 'donation' || /don/i.test(b.item_name || '') || b.txn_type === 'web_accept' && /don/i.test(b.transaction_subject || '');
    const name = [b.first_name, b.last_name].filter(Boolean).join(' ') || b.payer_email || 'Anonyme';
    const status = b.payment_status || '—';
    const ok = status === 'Completed';
    return { embeds: [embed({ color: ok ? COLORS.success : (status === 'Refunded' || status === 'Reversed' ? COLORS.warning : PAYPAL), title: `${donation ? '💝 Nouveau don' : '💰 Paiement PayPal'}${ok ? '' : ` (${status})`}`, fields: [{ name: 'Montant', value: formatMoney(b.mc_gross, b.mc_currency, { minorUnits: false }), inline: true }, { name: 'De', value: truncate(name, 1024), inline: true }, ...(b.item_name ? [{ name: 'Objet', value: truncate(b.item_name, 1024), inline: true }] : []), ...(b.memo ? [{ name: 'Message', value: truncate(b.memo, 1024) }] : [])], footer: `PayPal IPN • ${b.txn_type || ''} • ${b.txn_id || ''}`, timestamp: true })] };
  }
  const type = b.event_type || '?';
  const r = b.resource || {};
  const unit = r.purchase_units?.[0] || {};
  const amount = r.amount || unit.amount || r.gross_amount || {};
  const money = formatMoney(amount.value ?? amount.total, amount.currency_code ?? amount.currency, { minorUnits: false });
  const payer = r.payer?.email_address || [r.payer?.name?.given_name, r.payer?.name?.surname].filter(Boolean).join(' ') || r.subscriber?.email_address || unit.payee?.email_address || '—';
  const map = {
    'PAYMENT.CAPTURE.COMPLETED': ['💰 Paiement reçu', COLORS.success], 'PAYMENT.SALE.COMPLETED': ['💰 Paiement reçu', COLORS.success], 'CHECKOUT.ORDER.APPROVED': ['🛒 Commande approuvée', COLORS.success], 'CHECKOUT.ORDER.COMPLETED': ['🛒 Commande finalisée', COLORS.success],
    'PAYMENT.CAPTURE.REFUNDED': ['↩️ Remboursement', COLORS.warning], 'PAYMENT.CAPTURE.DENIED': ['⚠️ Paiement refusé', COLORS.error], 'BILLING.SUBSCRIPTION.ACTIVATED': ['🆕 Abonnement activé', COLORS.success], 'BILLING.SUBSCRIPTION.CANCELLED': ['❌ Abonnement annulé', COLORS.error],
  };
  const [title, color] = map[type] || [`PayPal : ${type}`, PAYPAL];
  return { embeds: [embed({ color, title, description: b.summary ? truncate(b.summary, 500) : undefined, fields: [{ name: 'Montant', value: money, inline: true }, { name: 'Payeur', value: truncate(payer, 1024), inline: true }, ...(unit.description ? [{ name: 'Description', value: truncate(unit.description, 1024) }] : [])], footer: `PayPal • ${b.id || ''}`, timestamp: b.create_time || true })] };
}

/* ------------------------------ Trello ------------------------------ */

export function formatTrello(b = {}) {
  const a = b.action || {};
  const d = a.data || {};
  const who = a.memberCreator?.fullName || a.memberCreator?.username || '?';
  const card = d.card || {};
  const url = card.shortLink ? `https://trello.com/c/${card.shortLink}` : undefined;
  const board = d.board?.name || b.model?.name || '?';
  switch (a.type) {
    case 'createCard':
      return { embeds: [embed({ color: TRELLO, author: { name: who }, title: `[${board}] 🆕 Carte créée : ${card.name}`, url, fields: [{ name: 'Liste', value: d.list?.name || '—', inline: true }] })] };
    case 'updateCard': {
      if (d.listBefore && d.listAfter) return { embeds: [embed({ color: TRELLO, author: { name: who }, title: `[${board}] ➡️ Carte déplacée : ${card.name}`, url, description: `**${d.listBefore.name}** → **${d.listAfter.name}**` })] };
      if (d.old && 'closed' in d.old) return { embeds: [embed({ color: card.closed ? COLORS.neutral : TRELLO, author: { name: who }, title: `[${board}] ${card.closed ? '🗄️ Carte archivée' : '♻️ Carte restaurée'} : ${card.name}`, url })] };
      const changed = Object.keys(d.old || {}).join(', ');
      return { embeds: [embed({ color: TRELLO, author: { name: who }, title: `[${board}] ✏️ Carte modifiée : ${card.name}`, url, description: changed ? `Champs modifiés : ${changed}` : undefined })] };
    }
    case 'commentCard':
      return { embeds: [embed({ color: TRELLO, author: { name: who }, title: `[${board}] 💬 Commentaire sur « ${card.name} »`, url, description: truncate(d.text || '', 1000) })] };
    default:
      if (!a.type) return null;
      return { embeds: [embed({ color: TRELLO, author: { name: who }, title: `[${board}] Trello : ${a.type}`, url })] };
  }
}

/* ------------------------------ Jira ------------------------------ */

export function formatJira(b = {}) {
  const ev = b.webhookEvent || b.issue_event_type_name || '?';
  const issue = b.issue || {};
  const f = issue.fields || {};
  let url;
  try { url = issue.self ? `${new URL(issue.self).origin}/browse/${issue.key}` : undefined; } catch { url = undefined; }
  const who = b.user?.displayName || b.comment?.author?.displayName || '?';
  const fields = [{ name: 'Type', value: f.issuetype?.name || '—', inline: true }, { name: 'Statut', value: f.status?.name || '—', inline: true }, { name: 'Priorité', value: f.priority?.name || '—', inline: true }];
  if (f.assignee?.displayName) fields.push({ name: 'Assigné à', value: f.assignee.displayName, inline: true });
  switch (ev) {
    case 'jira:issue_created':
      return { embeds: [embed({ color: JIRA, author: { name: who }, title: `🆕 ${issue.key} : ${f.summary}`, url, description: typeof f.description === 'string' ? truncate(f.description, 500) : adfToText(f.description, 500), fields })] };
    case 'jira:issue_updated': {
      const changes = (b.changelog?.items || []).map((i) => `**${i.field}** : ${i.fromString ?? '—'} → ${i.toString ?? '—'}`);
      if (!changes.length && !b.comment) return null;
      return { embeds: [embed({ color: JIRA, author: { name: who }, title: `✏️ ${issue.key} : ${f.summary}`, url, description: truncate(changes.join('\n') || (b.comment ? `💬 ${typeof b.comment.body === 'string' ? b.comment.body : adfToText(b.comment.body, 800)}` : ''), 1500), fields })] };
    }
    case 'jira:issue_deleted':
      return { embeds: [embed({ color: COLORS.error, author: { name: who }, title: `🗑️ ${issue.key} supprimé : ${f.summary}` })] };
    case 'comment_created':
      return { embeds: [embed({ color: JIRA, author: { name: who }, title: `💬 Commentaire sur ${issue.key} : ${f.summary || ''}`, url, description: typeof b.comment?.body === 'string' ? truncate(b.comment.body, 1000) : adfToText(b.comment?.body, 1000) })] };
    default:
      return { embeds: [embed({ color: JIRA, author: { name: who }, title: `Jira : ${ev}${issue.key ? ` (${issue.key})` : ''}`, url })] };
  }
}

/** Flatten an Atlassian Document Format node to plain text. */
export function adfToText(node, max = 1000) {
  if (!node) return undefined;
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (n.type === 'text' && n.text) out.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
    if (['paragraph', 'heading', 'listItem'].includes(n.type)) out.push('\n');
  };
  walk(node);
  return truncate(out.join('').trim(), max) || undefined;
}

/** Build an ADF document from plain text (Jira REST v3). */
export function textToAdf(text) {
  const paragraphs = String(text || '').split(/\n{2,}/).filter((p) => p.trim());
  return { type: 'doc', version: 1, content: (paragraphs.length ? paragraphs : ['']).map((p) => ({ type: 'paragraph', content: p ? p.split('\n').flatMap((line, i, arr) => [{ type: 'text', text: line || ' ' }, ...(i < arr.length - 1 ? [{ type: 'hardBreak' }] : [])]) : [] })) };
}

/* ------------------------------ Uptime Kuma ------------------------------ */

export function formatUptimeKuma(b = {}) {
  const hb = b.heartbeat || {};
  const mon = b.monitor || {};
  if (!b.heartbeat && !b.monitor) return { embeds: [embed({ color: COLORS.info, title: '📡 Uptime Kuma', description: truncate(b.msg || 'Notification de test', 1000) })] };
  const status = { 0: ['🔴 Hors ligne', COLORS.error], 1: ['🟢 En ligne', COLORS.success], 2: ['🟡 En attente', COLORS.warning], 3: ['🔧 Maintenance', COLORS.info] }[hb.status] || ['❔ Inconnu', COLORS.neutral];
  return { embeds: [embed({ color: status[1], title: `${status[0]} : ${mon.name || '?'}`, url: /^https?:\/\//.test(mon.url || '') ? mon.url : undefined, description: truncate(hb.msg || b.msg || '', 1000) || undefined, fields: [...(hb.ping !== undefined && hb.ping !== null ? [{ name: 'Latence', value: `${hb.ping} ms`, inline: true }] : []), { name: 'Type', value: mon.type || '—', inline: true }, ...(hb.time ? [{ name: 'Heure', value: String(hb.time), inline: true }] : [])], footer: 'Uptime Kuma' })] };
}

/* ------------------------------ ForgeHook ------------------------------ */

export function formatForgeHook(b = {}, headers = {}) {
  if (b.content || Array.isArray(b.embeds)) return discordCompatible(b);
  const event = b.event || h(headers, 'x-forgehook-event') || h(headers, 'x-heiphais-event') || 'évènement';
  const payload = b.payload ?? b.data ?? b;
  const fields = [];
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const [k, v] of Object.entries(payload).slice(0, 12)) {
      if (v === null || v === undefined) continue;
      fields.push({ name: truncate(k, 256), value: truncate(typeof v === 'object' ? `\`${JSON.stringify(v)}\`` : String(v), 1024), inline: String(v).length < 40 });
    }
  }
  return { embeds: [embed({ color: 0xf26522, title: `🔔 ForgeHook : ${event}`, description: b.message || b.summary || (fields.length ? undefined : `\`\`\`json\n${truncate(JSON.stringify(payload, null, 2), 1800)}\n\`\`\``), fields, footer: b.source ? `Source : ${b.source}` : 'ForgeHook', timestamp: b.timestamp || true })] };
}

/* ------------------------------ Generic ------------------------------ */

function discordCompatible(b) {
  const embeds = [];
  for (const raw of (Array.isArray(b.embeds) ? b.embeds : []).slice(0, 10)) {
    try { embeds.push(new EmbedBuilder(raw)); } catch { /* invalid embed skipped */ }
  }
  const out = {};
  if (b.content) out.content = truncate(String(b.content), 2000);
  if (embeds.length) out.embeds = embeds;
  return out.content || out.embeds ? out : null;
}

export function formatGeneric(b) {
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    const compat = (b.content || Array.isArray(b.embeds)) ? discordCompatible(b) : null;
    if (compat) return compat;
    const title = b.title || b.subject || b.event || b.name;
    const text = b.message || b.text || b.description || b.body;
    if (title || typeof text === 'string') return { embeds: [embed({ color: typeof b.color === 'number' ? b.color : COLORS.info, title: title ? truncate(String(title), 256) : 'Webhook', description: typeof text === 'string' ? truncate(text, 4000) : undefined, url: typeof b.url === 'string' && /^https?:\/\//.test(b.url) ? b.url : undefined, timestamp: true })] };
  }
  if (typeof b === 'string') return { embeds: [embed({ color: COLORS.info, title: 'Webhook', description: truncate(b, 4000) })] };
  return { embeds: [embed({ color: COLORS.info, title: 'Webhook reçu', description: `\`\`\`json\n${truncate(JSON.stringify(b, null, 2), 3900).replace(/```/g, "'''")}\n\`\`\``, timestamp: true })] };
}

/** Render a user template with {payload.a.b} / {headers.x} / {query.y}. JSON result = Discord message payload. */
export function formatTemplate(template, { body, headers = {}, query = {} }) {
  const rendered = renderTemplate(template, { payload: body, body, headers, query });
  const trimmed = rendered.trim();
  if (trimmed.startsWith('{')) {
    try { const parsed = JSON.parse(trimmed); const compat = discordCompatible(parsed); if (compat) return compat; } catch { /* not JSON */ }
  }
  return { embeds: [embed({ color: COLORS.info, description: truncate(rendered, 4096) })] };
}

/* ------------------------------ Samples (hooks test) ------------------------------ */

export const SAMPLES = {
  generic: { body: { title: 'Test HeiphaisBot', message: 'Ceci est un **webhook de test**.', value: 42 }, headers: {} },
  github: { headers: { 'x-github-event': 'push' }, body: { ref: 'refs/heads/main', compare: 'https://github.com/heiphaistos/demo/compare/a...b', repository: { full_name: 'heiphaistos/demo', html_url: 'https://github.com/heiphaistos/demo' }, sender: { login: 'heiphaistos', avatar_url: 'https://github.com/github.png', html_url: 'https://github.com/heiphaistos' }, commits: [{ id: '1a2b3c4d5e6f7a8b9c0d', url: 'https://github.com/heiphaistos/demo/commit/1a2b3c4', message: 'Ajout du module intégrations\n\nDétails…', author: { username: 'heiphaistos' } }, { id: 'abcdef1234567890abcd', url: 'https://github.com/heiphaistos/demo/commit/abcdef1', message: 'Correction des signatures', author: { username: 'heiphaistos' } }] } },
  gitlab: { headers: { 'x-gitlab-event': 'Pipeline Hook' }, body: { object_kind: 'pipeline', project: { path_with_namespace: 'heiphaistos/demo', web_url: 'https://gitlab.com/heiphaistos/demo' }, user: { username: 'heiphaistos' }, object_attributes: { id: 1234, status: 'success', ref: 'main', duration: 87, sha: 'deadbeefcafe' }, commit: { message: 'Mise à jour CI' } } },
  stripe: { headers: {}, body: { id: 'evt_test', type: 'checkout.session.completed', livemode: false, created: Math.floor(Date.now() / 1000), data: { object: { id: 'cs_test_123', amount_total: 1999, currency: 'eur', mode: 'payment', payment_status: 'paid', customer_details: { email: 'client@example.com' } } } } },
  paypal: { headers: {}, body: { id: 'WH-TEST', event_type: 'PAYMENT.CAPTURE.COMPLETED', summary: 'Paiement de 10,00 EUR reçu', resource: { amount: { value: '10.00', currency_code: 'EUR' } }, create_time: new Date().toISOString() } },
  trello: { headers: {}, body: { model: { name: 'Projet' }, action: { type: 'updateCard', memberCreator: { fullName: 'Heiphaistos' }, data: { board: { name: 'Projet' }, card: { name: 'Écrire la doc', shortLink: 'abc123' }, listBefore: { name: 'À faire' }, listAfter: { name: 'En cours' } } } } },
  jira: { headers: {}, body: { webhookEvent: 'jira:issue_created', user: { displayName: 'Heiphaistos' }, issue: { key: 'HB-42', self: 'https://example.atlassian.net/rest/api/3/issue/10042', fields: { summary: 'Bug du panel', issuetype: { name: 'Bug' }, status: { name: 'À faire' }, priority: { name: 'Haute' }, description: 'Le panel ne charge pas.' } } } },
  uptimekuma: { headers: {}, body: { heartbeat: { status: 0, msg: 'Connection refused', ping: null, time: new Date().toISOString() }, monitor: { name: 'Site web', url: 'https://example.com', type: 'http' }, msg: '[Site web] [🔴 Down] Connection refused' } },
  forgehook: { headers: {}, body: { event: 'deploy.finished', source: 'ForgeHook', payload: { app: 'forgearchive', version: '1.4.0', status: 'ok' } } },
};

/* ------------------------------ Signature verification ------------------------------ */

/** Parse a Stripe-Signature header: "t=123,v1=abc,v1=def,v0=..." */
export function parseStripeSignature(header) {
  const out = { t: null, v1: [] };
  for (const part of String(header || '').split(',')) {
    const [k, ...rest] = part.trim().split('=');
    const v = rest.join('=');
    if (k === 't') out.t = v;
    else if (k === 'v1') out.v1.push(v);
  }
  return out;
}

export function stripeSignatureFor(secret, timestamp, raw) {
  return crypto.createHmac('sha256', String(secret)).update(Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw))])).digest('hex');
}

/**
 * Verify an incoming webhook request against the hook secret.
 * Accepted: provider signatures (GitHub/Jira/ForgeHook X-Hub-Signature(-256) / X-Heiphais-Signature, GitLab X-Gitlab-Token,
 * Stripe Stripe-Signature v1, Trello X-Trello-Webhook) or the plain secret via ?secret=, X-Secret, X-Webhook-Secret, Authorization.
 * @returns {{ ok: boolean, method?: string, reason?: string }}
 */
export function verifyIncomingSignature(hook, { raw = Buffer.alloc(0), headers = {}, query = {}, fullUrl = '', now = Date.now(), toleranceSec = 300 }) {
  const secret = hook.secret;
  if (!secret) return { ok: true, method: 'none' };
  const rawBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''));
  const auth = h(headers, 'authorization');
  const provided = query?.secret || h(headers, 'x-secret') || h(headers, 'x-webhook-secret') || (auth ? String(auth).replace(/^(Bearer|Token|Basic)\s+/i, '') : null);
  if (provided && safeEqual(provided, secret)) return { ok: true, method: 'secret' };
  const hubSig = h(headers, 'x-hub-signature-256') || h(headers, 'x-heiphais-signature') || h(headers, 'x-forgehook-signature') || h(headers, 'x-hub-signature');
  if (hubSig) {
    const idx = String(hubSig).indexOf('=');
    const algo = idx > 0 ? String(hubSig).slice(0, idx).toLowerCase() : 'sha256';
    const hex = idx > 0 ? String(hubSig).slice(idx + 1) : String(hubSig);
    if (['sha256', 'sha1'].includes(algo) && safeEqual(hex.toLowerCase(), hmacHex(secret, rawBuf, algo))) return { ok: true, method: `hmac-${algo}` };
    return { ok: false, reason: 'Signature HMAC invalide' };
  }
  const glToken = h(headers, 'x-gitlab-token');
  if (glToken !== undefined) return safeEqual(glToken, secret) ? { ok: true, method: 'gitlab-token' } : { ok: false, reason: 'X-Gitlab-Token invalide' };
  const stripeSig = h(headers, 'stripe-signature');
  if (stripeSig) {
    const { t, v1 } = parseStripeSignature(stripeSig);
    if (!t || !v1.length) return { ok: false, reason: 'En-tête Stripe-Signature mal formé' };
    if (Math.abs(Math.floor(now / 1000) - Number(t)) > toleranceSec) return { ok: false, reason: 'Horodatage Stripe hors tolérance' };
    const expected = stripeSignatureFor(secret, t, rawBuf);
    return v1.some((s) => safeEqual(s, expected)) ? { ok: true, method: 'stripe' } : { ok: false, reason: 'Signature Stripe invalide' };
  }
  const trelloSig = h(headers, 'x-trello-webhook');
  if (trelloSig) {
    const expected = crypto.createHmac('sha1', String(secret)).update(Buffer.concat([rawBuf, Buffer.from(fullUrl)])).digest('base64');
    return safeEqual(trelloSig, expected) ? { ok: true, method: 'trello' } : { ok: false, reason: 'Signature Trello invalide' };
  }
  return { ok: false, reason: 'Secret manquant ou invalide' };
}
