// Import / export de la configuration du serveur.
import { h, downloadFile, fmtDate } from '../utils.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, loadCatalog, invalidateGuild, guildInfo } from '../state.js';
import { pageHeader, card, button, withLoading, jsonDetails, badge } from '../components/ui.js';
import { confirmDialog } from '../components/modal.js';
import { toast } from '../components/toast.js';

export default async function configPage(ctx) {
  const gid = ctx.guildId;
  ctx.setTitle('Configuration');
  await loadCatalog().catch(() => null);
  if (!ctx.isCurrent()) return;
  const g = guildInfo(gid);

  // ---- Export ----
  const exportInfo = h('div');
  const exportBtn = button({ label: 'Télécharger l\'export JSON', icon: 'download', variant: 'primary', onClick: () => withLoading(exportBtn, async () => {
    const r = await api.get(`/guilds/${gid}/export`);
    const date = new Date().toISOString().slice(0, 10);
    downloadFile(`heiphaisbot-${gid}-${date}.json`, JSON.stringify(r.export, null, 2));
    exportInfo.replaceChildren(summary(r.export), jsonDetails(r.export, 'Contenu exporté'));
    toast.success('Configuration exportée');
  }).catch(() => null) });

  // ---- Import ----
  let pending = null;
  const preview = h('div');
  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', id: 'import-file', class: 'sr-only' });
  const drop = h('label', { class: 'dropzone', for: 'import-file', tabindex: '0' }, icon('upload', 28), h('strong', {}, 'Déposez un fichier JSON ici'), h('span', { class: 'muted small' }, 'ou cliquez pour parcourir'));
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  const paste = h('textarea', { class: 'input textarea mono', rows: 5, placeholder: 'Ou collez le JSON exporté ici…', 'aria-label': 'JSON à importer', spellcheck: 'false' });
  const importBtn = button({ label: 'Importer', icon: 'upload', variant: 'primary', disabled: true, onClick: doImport });

  const readText = (text, source) => {
    try {
      const data = JSON.parse(text);
      const exp = data.export && typeof data.export === 'object' ? data.export : data;
      if (!exp || typeof exp !== 'object' || (!exp.modules && !exp.settings)) throw new Error('Le fichier ne contient ni « modules » ni « settings »');
      pending = exp;
      importBtn.disabled = false;
      preview.replaceChildren(h('div', { class: 'callout callout-info' }, icon('file', 16), `Source : ${source}`),
        exp.guildId && exp.guildId !== gid ? h('div', { class: 'callout callout-warn' }, icon('alert', 16), `Cet export provient d'un autre serveur (${exp.guildId}). Les IDs de salons et de rôles ne correspondront probablement pas.`) : null,
        summary(exp));
    } catch (err) {
      pending = null; importBtn.disabled = true;
      preview.replaceChildren(h('div', { class: 'callout callout-danger' }, icon('alert', 16), `JSON invalide : ${err.message}`));
    }
  };
  fileInput.addEventListener('change', async () => { const f = fileInput.files[0]; if (f) readText(await f.text(), f.name); });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) readText(await f.text(), f.name); });
  paste.addEventListener('input', () => { if (paste.value.trim()) readText(paste.value, 'texte collé'); else { pending = null; importBtn.disabled = true; preview.replaceChildren(); } });

  async function doImport() {
    if (!pending) return;
    if (!(await confirmDialog({ title: 'Importer la configuration', message: `Les paramètres et états des modules présents dans le fichier remplaceront ceux de « ${g?.name || gid} ».`, confirmLabel: 'Importer', danger: true }))) return;
    await withLoading(importBtn, async () => {
      await api.post(`/guilds/${gid}/import`, { export: pending });
      invalidateGuild(gid);
      toast.success('Configuration importée');
      pending = null; importBtn.disabled = true; paste.value = ''; fileInput.value = '';
      preview.replaceChildren(h('div', { class: 'callout callout-success' }, icon('check', 16), 'Import terminé.'));
    }).catch(() => null);
  }

  ctx.el.append(pageHeader({ title: 'Import / export', icon: 'file', subtitle: 'Sauvegardez la configuration du bot (modules activés et paramètres) ou restaurez-la.' }),
    h('div', { class: 'grid-2' },
      card({ title: 'Exporter', icon: 'download', subtitle: 'Fichier JSON contenant l\'état des modules et leurs paramètres.', body: [exportBtn, exportInfo] }),
      card({ title: 'Importer', icon: 'upload', subtitle: 'Restaure un export précédent sur ce serveur.', body: [fileInput, drop, paste, preview, h('div', { class: 'runner-actions' }, importBtn)] })));
}

function summary(exp) {
  const mods = Object.entries(exp.modules || {});
  const settings = Object.keys(exp.settings || {});
  const label = (n) => state.catalogMap.get(n) ? `${state.catalogMap.get(n).icon} ${state.catalogMap.get(n).label}` : n;
  return h('div', { class: 'import-summary' },
    exp.exportedAt ? h('p', { class: 'muted small' }, `Exporté le ${fmtDate(exp.exportedAt, { long: true })}${exp.guildId ? ` depuis ${exp.guildId}` : ''}`) : null,
    h('div', { class: 'detail-title' }, `États des modules (${mods.length})`),
    mods.length ? h('div', { class: 'chip-grid' }, mods.map(([n, on]) => badge(`${on ? '🟢' : '🔴'} ${label(n)}`, 'default'))) : h('p', { class: 'muted small' }, 'Aucun (valeurs par défaut)'),
    h('div', { class: 'detail-title' }, `Paramètres personnalisés (${settings.length})`),
    settings.length ? h('div', { class: 'chip-grid' }, settings.map((n) => badge(label(n), 'accent'))) : h('p', { class: 'muted small' }, 'Aucun'));
}
