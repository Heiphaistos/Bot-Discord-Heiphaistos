// Tâches planifiées du serveur.
import { h, fmtDuration, fmtRelative } from '../utils.js';
import { api } from '../api.js';
import { pageHeader, card, button, withLoading, jsonBlock } from '../components/ui.js';
import { createDataTable } from '../components/table.js';
import { confirmDialog } from '../components/modal.js';
import { toast } from '../components/toast.js';

export default async function jobsPage(ctx) {
  const gid = ctx.guildId;
  ctx.setTitle('Tâches planifiées');
  const table = createDataTable({
    guildId: gid,
    columns: [
      { key: 'id', label: '#', type: 'number' }, { key: 'module', label: 'Module' }, { key: 'type', label: 'Type' },
      { key: 'run_at', label: 'Prochaine exécution', type: 'date' }, { key: 'in', label: 'Échéance', sortable: false },
      { key: 'repeat', label: 'Répétition', sortable: false }, { key: 'created_at', label: 'Créée le', type: 'date' },
    ],
    emptyText: 'Aucune tâche planifiée', emptyIcon: 'clock',
    initialSort: { key: 'run_at', dir: 1 },
    expand: (row) => h('div', {}, h('div', { class: 'detail-title' }, 'Charge utile (payload)'), jsonBlock(row.payload ?? {})),
    rowActions: (row) => [button({ label: 'Annuler', icon: 'trash', size: 'sm', variant: 'danger-ghost', onClick: async () => {
      if (!(await confirmDialog({ title: 'Annuler la tâche', message: `Supprimer la tâche #${row.id} (${row.module} · ${row.type}) ? Elle ne sera pas exécutée.`, confirmLabel: 'Supprimer', danger: true }))) return;
      try { await api.del(`/guilds/${gid}/jobs/${row.id}`); toast.success(`Tâche #${row.id} annulée`); load(); } catch { /* toast */ }
    } })],
  });
  const refresh = button({ label: 'Actualiser', icon: 'refresh', onClick: () => withLoading(refresh, load) });
  ctx.el.append(pageHeader({ title: 'Tâches planifiées', icon: 'clock', subtitle: 'Rappels, fins de sanctions temporaires, tirages, flux… Les tâches survivent aux redémarrages.', actions: [refresh] }), card({ body: table.el, cls: 'card-flush' }));
  async function load() {
    table.setLoading(true);
    try {
      const r = await api.get(`/guilds/${gid}/jobs`);
      if (!ctx.isCurrent()) return;
      table.setRows((r.jobs || []).map((j) => ({ ...j, in: fmtRelative(j.run_at), repeat: j.repeat_ms ? `toutes les ${fmtDuration(j.repeat_ms)}` : 'unique' })));
    } catch { table.setRows([]); }
  }
  await load();
  const t = setInterval(() => table.rerender(), 30000);
  ctx.onCleanup(() => clearInterval(t));
}
