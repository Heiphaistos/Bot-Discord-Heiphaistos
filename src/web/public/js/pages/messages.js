// Envoi de messages et d'embeds (actions admin.say / admin.embed) avec aperçu live.
import { h, store } from '../utils.js';
import { icon } from '../icons.js';
import { state, getChannels, getRoles, loadCatalog, getActionDesc, botName } from '../state.js';
import { pageHeader, card, tabs, button, withLoading, emptyState } from '../components/ui.js';
import { createField } from '../components/form.js';
import { runAction, renderResult } from '../components/action.js';
import { renderDiscordMessage } from '../components/markdown.js';
import { toast } from '../components/toast.js';

const TEXT_TYPES = ['GuildText', 'GuildAnnouncement', 'PublicThread', 'PrivateThread'];

export default async function messagesPage(ctx) {
  const gid = ctx.guildId;
  ctx.setTitle('Messages');
  await Promise.all([loadCatalog(), getChannels(gid).catch(() => null), getRoles(gid).catch(() => null)]);
  if (!ctx.isCurrent()) return;
  const mode = ctx.query.mode === 'embed' ? 'embed' : 'message';
  ctx.el.append(pageHeader({ title: 'Messages', icon: 'message', subtitle: 'Faites parler le bot : message simple ou embed personnalisé, avec aperçu en direct.' }),
    tabs([{ id: 'message', label: 'Message', icon: 'message', href: `#/g/${gid}/messages` }, { id: 'embed', label: 'Embed', icon: 'sparkles', href: `#/g/${gid}/messages?mode=embed` }], mode));
  const sayDesc = getActionDesc('admin', 'say');
  const embedDesc = getActionDesc('admin', 'embed');
  if (!sayDesc || !embedDesc) { ctx.el.append(emptyState({ icon: 'alert', title: 'Actions indisponibles', text: 'Les actions admin.say / admin.embed sont introuvables.' })); return; }
  const author = { name: state.me?.botUser?.tag?.split('#')[0] || botName(), avatar: state.me?.botUser?.avatar };
  const preview = h('div', { class: 'dc-preview dc-preview-live' });
  const resultSlot = h('div');
  const lastChannel = store.get(`lastChannel.${gid}`, null);
  const channel = createField('channel', { ...sayDesc.params.channel, label: 'Salon', description: 'Salon où publier le message', required: true, channelTypes: TEXT_TYPES }, { guildId: gid, value: lastChannel });
  const sendBtn = button({ label: 'Envoyer', icon: 'send', variant: 'primary', type: 'submit' });
  let fields; let draftKey;

  if (mode === 'message') {
    draftKey = `draft.say.${gid}`;
    const msg = createField('message', { type: 'text', label: 'Contenu', description: 'Markdown Discord : **gras**, *italique*, `code`, <@id>, <#id>…', required: true, maxLength: 2000 }, { value: store.get(draftKey, ''), onChange: update });
    const counter = h('span', { class: 'muted small counter' });
    fields = { msg };
    ctx.el.append(h('div', { class: 'compose' }, card({ title: 'Rédaction', body: formOf([channel.el, msg.el, counter]) }), card({ title: 'Aperçu', icon: 'eye', body: [preview, resultSlot] })));
    function update() {
      const text = msg.getValue() || '';
      counter.textContent = `${text.length} / 2000`;
      counter.classList.toggle('over', text.length > 2000);
      store.set(draftKey, text);
      preview.replaceChildren(text ? renderDiscordMessage({ author, content: text, guildId: gid }) : h('p', { class: 'muted small' }, 'L\'aperçu apparaîtra ici.'));
    }
    msg.el.querySelector('textarea').addEventListener('input', update);
    update();
  } else {
    draftKey = `draft.embed.${gid}`;
    const draft = store.get(draftKey, {});
    const p = embedDesc.params;
    const mk = (k, over = {}) => createField(k, { ...p[k], label: over.label || p[k]?.description || k, description: over.description || '', ...over }, { guildId: gid, value: draft[k] ?? (k === 'color' ? '#5865F2' : undefined), onChange: update });
    fields = {
      title: mk('title', { label: 'Titre' }), description: mk('description', { label: 'Description', description: 'Markdown Discord supporté' }), color: mk('color', { label: 'Couleur' }),
      author: mk('author', { label: 'Auteur' }), thumbnail: mk('thumbnail', { label: 'Miniature (URL)' }), image: mk('image', { label: 'Image (URL)' }),
      footer: mk('footer', { label: 'Pied de page' }), timestamp: mk('timestamp', { label: 'Horodatage', description: 'Afficher la date d\'envoi' }),
      content: mk('content', { label: 'Texte au-dessus de l\'embed' }), message_id: mk('message_id', { label: 'Modifier un message existant (ID)', description: 'Laisser vide pour envoyer un nouveau message' }),
    };
    const fieldRows = h('div', { class: 'embed-fields-editor' });
    let efields = Array.isArray(draft.fields) ? draft.fields : [];
    function renderFieldRows() {
      fieldRows.replaceChildren(...efields.map((f, i) => {
        const name = h('input', { class: 'input', placeholder: 'Nom', value: f.name || '', 'aria-label': `Nom du champ ${i + 1}`, maxlength: 256 });
        const value = h('textarea', { class: 'input textarea', rows: 2, placeholder: 'Valeur', 'aria-label': `Valeur du champ ${i + 1}`, maxlength: 1024 });
        value.value = f.value || '';
        const inline = h('input', { type: 'checkbox', checked: !!f.inline, id: `ef-inline-${i}` });
        name.addEventListener('input', () => { f.name = name.value; update(); });
        value.addEventListener('input', () => { f.value = value.value; update(); });
        inline.addEventListener('change', () => { f.inline = inline.checked; update(); });
        return h('div', { class: 'embed-field-row' }, h('div', { class: 'embed-field-inputs' }, name, value),
          h('div', { class: 'embed-field-tools' }, h('label', { class: 'check-label small', for: `ef-inline-${i}` }, inline, 'En ligne'),
            button({ icon: 'trash', size: 'sm', variant: 'ghost', title: 'Supprimer le champ', onClick: () => { efields.splice(i, 1); renderFieldRows(); update(); } })));
      }), efields.length < 25 ? button({ label: 'Ajouter un champ', icon: 'plus', size: 'sm', onClick: () => { efields.push({ name: '', value: '', inline: false }); renderFieldRows(); update(); } }) : null);
    }
    fields.getEmbedFields = () => efields.filter((f) => f.name || f.value).map((f) => ({ name: f.name || '​', value: f.value || '​', inline: !!f.inline }));
    renderFieldRows();
    ctx.el.append(h('div', { class: 'compose' },
      card({ title: 'Embed', body: formOf([channel.el, fields.content.el,
        h('fieldset', { class: 'form-group' }, h('legend', {}, 'En-tête'), h('div', { class: 'form-grid' }, fields.author.el, fields.color.el, fields.title.el)),
        h('div', { class: 'field-wide' }, fields.description.el),
        h('fieldset', { class: 'form-group' }, h('legend', {}, 'Champs'), fieldRows),
        h('fieldset', { class: 'form-group' }, h('legend', {}, 'Images et pied de page'), h('div', { class: 'form-grid' }, fields.thumbnail.el, fields.image.el, fields.footer.el, fields.timestamp.el)),
        h('details', { class: 'advanced' }, h('summary', {}, icon('chevronRight', 14, 'chev'), 'Avancé'), fields.message_id.el),
        button({ label: 'Réinitialiser le brouillon', icon: 'refresh', size: 'sm', variant: 'ghost', onClick: () => { store.remove(draftKey); ctx.refresh(); } })]) }),
      card({ title: 'Aperçu', icon: 'eye', body: [preview, resultSlot], cls: 'sticky-preview' })));
    for (const f of Object.values(fields)) if (f?.el) f.el.addEventListener('input', update);
    function update() {
      const v = embedValues();
      store.set(draftKey, { ...v, fields: efields });
      const e = { title: v.title, description: v.description, color: v.color ? parseInt(v.color.replace('#', ''), 16) : 0x5865f2, author: v.author ? { name: v.author } : undefined, thumbnail: v.thumbnail ? { url: v.thumbnail } : undefined, image: v.image ? { url: v.image } : undefined, footer: v.footer ? { text: v.footer } : undefined, timestamp: v.timestamp ? new Date().toISOString() : undefined, fields: fields.getEmbedFields() };
      const empty = !v.title && !v.description && !v.image && !e.fields.length;
      preview.replaceChildren(empty && !v.content ? h('p', { class: 'muted small' }, 'Remplissez au moins un titre, une description, une image ou un champ.') : renderDiscordMessage({ author, content: v.content || '', embeds: empty ? [] : [e], guildId: gid }));
    }
    update();
  }

  function embedValues() {
    const out = {};
    for (const [k, f] of Object.entries(fields)) if (f?.getValue) out[k] = f.getValue();
    return out;
  }

  function formOf(children) {
    const form = h('form', { class: 'form', novalidate: true }, children, h('div', { class: 'runner-actions' }, sendBtn));
    form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
    return form;
  }

  async function send() {
    const fs = [channel, ...Object.values(fields).filter((f) => f?.validate)];
    if (fs.map((f) => f.validate()).some(Boolean)) { toast.warn('Corrigez les champs en erreur'); return; }
    store.set(`lastChannel.${gid}`, channel.getValue());
    let params;
    if (mode === 'message') params = { channel: channel.getValue(), message: fields.msg.getValue() };
    else {
      const v = embedValues();
      params = { channel: channel.getValue() };
      for (const [k, val] of Object.entries(v)) if (val !== null && val !== '' && val !== false) params[k] = val;
      const ef = fields.getEmbedFields();
      if (ef.length) params.fields = ef;
      if (!params.title && !params.description && !params.image && !params.fields) { toast.warn('Ajoutez au moins un titre, une description, une image ou un champ'); return; }
    }
    await withLoading(sendBtn, async () => {
      const res = await runAction(gid, 'admin', mode === 'message' ? 'say' : 'embed', params);
      resultSlot.replaceChildren(renderResult(res, { guildId: gid }));
      if (res.ok !== false && !res.error) {
        toast.success(mode === 'message' ? 'Message envoyé' : 'Embed envoyé');
        if (mode === 'message') { store.remove(draftKey); }
      }
    });
  }
}
