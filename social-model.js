(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NexusModel = api;
})(globalThis, function () {
  'use strict';
  const KEY = 'nexus_social_v1';
  const MAX_TEXT = 4000;
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
  const text = (value, max = MAX_TEXT) => typeof value === 'string' ? value.replace(/\u0000/g, '').slice(0, max).trim() : '';
  const uid = () => globalThis.crypto.randomUUID();
  const clone = value => JSON.parse(JSON.stringify(value));
  const profile = value => ({ name: text(value?.name, 32) || 'Visitante', avatar: text(value?.avatar, 64) || 'chrome' });
  const empty = () => ({ version: 1, contacts: {}, spaces: {}, threads: {}, outbox: [], reads: {}, bookmarks: [], preferences: { requests: true, presence: 'online' } });

  function normalizeMessage(value, author) {
    if (!value || !validId(value.id) || !validId(author || value.author)) return null;
    const body = text(value.text);
    if (!body && !value.deleted && !value.invite) return null;
    const created = Number(value.createdAt);
    return {
      id: value.id, author: author || value.author, ...profile({ name: value.name, avatar: value.avatar }),
      text: value.deleted ? '' : body, createdAt: Number.isFinite(created) && created > 0 && created < Date.now() + 300000 ? created : Date.now(),
      editedAt: Number(value.editedAt) || 0, revision: Math.max(0, Number(value.revision) || 0), deleted: !!value.deleted,
      replyTo: validId(value.replyTo) ? value.replyTo : null,
      pinned: !!value.pinned, status: ['queued', 'delivered', 'read'].includes(value.status) ? value.status : 'delivered',
      invite: typeof value.invite === 'string' && value.invite.length < 2048 ? value.invite : null
    };
  }

  function normalizeSpace(value) {
    if (!value || !validId(value.id) || !validId(value.owner) || !Array.isArray(value.channels) || value.channels.length > 64) return null;
    const channels = value.channels.filter(channel => validId(channel?.id) && ['text', 'voice'].includes(channel.type)).map(channel => ({ id: channel.id, name: text(channel.name, 32) || 'geral', type: channel.type, topic: text(channel.topic, 160) }));
    if (!channels.length || new Set(channels.map(channel => channel.id)).size !== channels.length) return null;
    const members = {};
    Object.entries(value.members || {}).slice(0, 128).forEach(([id, member]) => { if (validId(id)) members[id] = profile(member); });
    return {
      id: value.id, owner: value.owner, name: text(value.name, 48) || 'Nosso espaço', topic: text(value.topic, 160), channels, members,
      revision: Math.max(1, Number(value.revision) || 1), createdAt: Number(value.createdAt) || Date.now(),
      invite: { token: text(value.invite?.token, 96), expiresAt: Number(value.invite?.expiresAt) || 0 },
      banned: (Array.isArray(value.banned) ? value.banned : []).filter(validId).slice(0, 128)
    };
  }

  class Store {
    constructor(storage, onError = () => {}) {
      this.storage = storage; this.onError = onError; this.listeners = new Set(); this.state = empty();
      try {
        const saved = JSON.parse(storage.getItem(KEY) || 'null');
        if (saved?.version === 1) {
          for (const [id, contact] of Object.entries(saved.contacts || {})) if (validId(id) && ['incoming', 'outgoing', 'accepted', 'blocked', 'removed'].includes(contact.state)) this.state.contacts[id] = { id, ...profile(contact), state: contact.state, updatedAt: Number(contact.updatedAt) || 0 };
          for (const room of Object.values(saved.spaces || {})) { const clean = normalizeSpace(room); if (clean) this.state.spaces[clean.id] = clean; }
          for (const [key, list] of Object.entries(saved.threads || {})) if (/^(dm|space):[A-Za-z0-9:_-]{1,200}$/.test(key) && Array.isArray(list)) this.state.threads[key] = list.map(item => normalizeMessage(item)).filter(Boolean);
          this.state.outbox = Array.isArray(saved.outbox) ? saved.outbox.filter(item => validId(item.id) && validId(item.peer) && typeof item.type === 'string').slice(-1000) : [];
          for (const [key, time] of Object.entries(saved.reads || {})) if (/^(dm|space):[A-Za-z0-9:_-]{1,200}$/.test(key) && Number.isFinite(time)) this.state.reads[key] = time;
          this.state.bookmarks = (Array.isArray(saved.bookmarks) ? saved.bookmarks : []).filter(validId).slice(-1000);
          this.state.preferences = { requests: saved.preferences?.requests !== false, presence: ['online', 'busy', 'away'].includes(saved.preferences?.presence) ? saved.preferences.presence : 'online' };
        }
      } catch (_) { this.onError('Não foi possível ler o histórico salvo. Os dados anteriores foram preservados.'); }
    }
    subscribe(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
    transaction(change) {
      const previous = clone(this.state);
      let result;
      try { result = change(this.state); this.storage.setItem(KEY, JSON.stringify(this.state)); }
      catch (error) { this.state = previous; this.onError('Não foi possível salvar. Confira o espaço disponível no navegador.'); throw error; }
      this.listeners.forEach(listener => { try { listener(); } catch (error) { console.error('Interface update failed', error); } });
      return result;
    }
    setContact(id, state, person = {}) {
      if (!validId(id) || !['incoming', 'outgoing', 'accepted', 'blocked', 'removed'].includes(state)) throw new Error('Contato inválido.');
      return this.transaction(data => data.contacts[id] = { ...data.contacts[id], id, ...profile({ ...data.contacts[id], ...person }), state, updatedAt: Date.now() });
    }
    contact(id) { return this.state.contacts[id]; }
    accepted(id) { return this.contact(id)?.state === 'accepted'; }
    blocked(id) { return this.contact(id)?.state === 'blocked'; }
    queue(peer, type, payload, id = uid()) {
      if (!validId(peer) || !validId(id)) throw new Error('Destino inválido.');
      return this.transaction(data => {
        if (data.outbox.some(item => item.id === id)) return id;
        if (data.outbox.length >= 1000) throw new Error('A fila de envio está cheia.');
        data.outbox.push({ id, peer, type, payload: clone(payload), createdAt: Date.now() }); return id;
      });
    }
    acknowledge(id) { if (this.state.outbox.some(item => item.id === id)) this.transaction(data => { data.outbox = data.outbox.filter(item => item.id !== id); }); }
    discardQueued(peer, types) { this.transaction(data => { data.outbox = data.outbox.filter(item => item.peer !== peer || (types && !types.includes(item.type))); }); }
    messages(key) { return this.state.threads[key] || []; }
    putMessage(key, value, author) {
      if (!/^(dm|space):[A-Za-z0-9:_-]{1,200}$/.test(key)) throw new Error('Conversa inválida.');
      const clean = normalizeMessage(value, author);
      if (!clean) throw new Error('Mensagem inválida.');
      const existing = this.messages(key).find(message => message.id === clean.id);
      if (existing && (existing.author !== clean.author || existing.revision >= clean.revision)) return false;
      return this.transaction(data => {
        const list = data.threads[key] ||= [];
        const index = list.findIndex(message => message.id === clean.id);
        if (index < 0) list.push(clean); else list[index] = { ...clean, status: existing.status === 'read' ? 'read' : clean.status };
        list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        return true;
      });
    }
    receipt(key, id, status) {
      const item = this.messages(key).find(message => message.id === id);
      if (!item || item.status === status || item.status === 'read') return;
      this.transaction(() => { item.status = status; });
    }
    markRead(key, time = Date.now()) { if ((this.state.reads[key] || 0) < time) this.transaction(data => { data.reads[key] = time; }); }
    unread(key, me) { return this.messages(key).filter(message => message.author !== me && !message.deleted && message.createdAt > (this.state.reads[key] || 0)).length; }
    bookmark(id) {
      if (!validId(id)) return;
      this.transaction(data => { data.bookmarks = data.bookmarks.includes(id) ? data.bookmarks.filter(value => value !== id) : [...data.bookmarks, id]; });
    }
    createSpace(me, person, name) {
      const space = normalizeSpace({ id: uid(), owner: me, name: text(name, 48) || 'Sala de ' + profile(person).name, topic: '', channels: [{ id: uid(), name: 'geral', type: 'text' }, { id: uid(), name: 'Ponto de encontro', type: 'voice' }], members: { [me]: profile(person) }, revision: 1, invite: { token: uid().replaceAll('-', ''), expiresAt: 0 } });
      this.transaction(data => { data.spaces[space.id] = space; }); return space;
    }
    upsertSpace(value) {
      const space = normalizeSpace(value);
      if (!space) throw new Error('Espaço inválido.');
      const existing = this.state.spaces[space.id];
      if (existing && (existing.owner !== space.owner || existing.revision > space.revision)) return false;
      this.transaction(data => { data.spaces[space.id] = space; }); return true;
    }
    updateSpace(id, me, change) {
      const space = this.state.spaces[id];
      if (!space || space.owner !== me) throw new Error('Só quem criou o espaço pode fazer esse ajuste.');
      const updated = clone(space); change(updated); updated.revision++;
      const normalized = normalizeSpace(updated);
      if (!normalized) throw new Error('Configuração inválida.');
      this.transaction(data => { data.spaces[id] = normalized; }); return normalized;
    }
    removeSpace(id) { this.transaction(data => { delete data.spaces[id]; }); }
  }

  function parseInvite(value) {
    const input = text(value, 2048);
    try {
      const url = new URL(input);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      const owner = url.searchParams.get('host'); const space = url.searchParams.get('space'); const token = url.searchParams.get('invite');
      if (!validId(owner) || !validId(space) || !/^[a-f0-9]{32}$/.test(token || '')) return null;
      return { owner, space, token };
    } catch (_) { return null; }
  }
  function parseContact(value) {
    let input = text(value, 2048);
    try { if (/^https?:\/\//.test(input)) input = new URL(input).searchParams.get('friend') || ''; } catch (_) { return null; }
    return /^nx-[a-f0-9]{32}$/.test(input) ? input : null;
  }
  function inviteLink(base, space) {
    const url = new URL(base); url.search = ''; url.hash = '';
    url.searchParams.set('host', space.owner); url.searchParams.set('space', space.id); url.searchParams.set('invite', space.invite.token); return url.href;
  }
  function contactLink(base, id) { const url = new URL(base); url.search = ''; url.hash = ''; url.searchParams.set('friend', id); return url.href; }
  return { Store, validId, text, uid, profile, clone, normalizeMessage, normalizeSpace, parseInvite, parseContact, inviteLink, contactLink, MAX_TEXT, KEY };
});
