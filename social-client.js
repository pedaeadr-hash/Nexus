(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./social-model.js'), require('./identity.js'));
  else root.NexusSocial = factory(root.NexusModel, root.NexusIdentity);
})(globalThis, function (M, Identity) {
  'use strict';
  const LABEL = 'nexus-social-v1';
  const MAX_FRAME = 65536;
  const authText = (from, to, challenge, nonce) => ['nexus-auth-v1', from, to, challenge, nonce].join('|');

  class Client {
    constructor({ store, identity, person, autoReconnect = true, connectionTimeout = 10000 }) {
      this.store = store; this.identity = identity; this.id = identity.id; this.person = person;
      this.links = new Map(); this.listeners = new Set(); this.presence = new Map(); this.rosters = new Map();
      this.seen = new Map(); this.sent = new Map(); this.retryAt = new Map(); this.joining = new Map(); this.typingAt = new Map();
      this.peer = null; this.ready = false; this.voice = null; this.pendingCall = null; this.outgoingCall = null;
      this.connectionTimeout = connectionTimeout; this.callTimer = null;
      if (autoReconnect) { this.interval = setInterval(() => this.tick(), 10000); this.interval.unref?.(); }
    }
    on(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
    emit(type, detail = {}) { this.listeners.forEach(listener => { try { listener({ type, ...detail }); } catch (error) { console.error('Social event failed', error); } }); }
    getProfile() { return M.profile(this.person()); }
    attachPeer(peer) {
      this.peer = peer; this.ready = true;
      Object.values(this.store.state.spaces).filter(space => space.owner === this.id).forEach(space => { if (!this.hostRoster(space.id).has(this.id)) this.hostRoster(space.id).set(this.id, { id: this.id, ...this.getProfile(), voice: null, muted: false, deafened: false, sharing: false }); });
      this.emit('ready'); this.tick();
    }
    offline() { this.ready = false; this.emit('network'); }
    isOnline(id) { return this.links.get(id)?.authenticated === true; }
    status(id) { return this.isOnline(id) ? this.presence.get(id) || 'online' : 'offline'; }
    hostRoster(id) { if (!this.rosters.has(id)) this.rosters.set(id, new Map()); return this.rosters.get(id); }
    roomRoster(id) { return [...(this.rosters.get(id)?.values() || [])]; }
    roomOnline(id) { const space = this.store.state.spaces[id]; return !!space && (space.owner === this.id ? this.ready : this.isOnline(space.owner)); }
    canManage(id) { return this.store.state.spaces[id]?.owner === this.id; }
    async connect(id, force = false) {
      if (!/^nx-[a-f0-9]{32}$/.test(id) || id === this.id || this.store.blocked(id) || !this.ready || !this.peer) return false;
      const current = this.links.get(id);
      if (current) return current.authenticated ? true : current.promise;
      if (!force && Date.now() < (this.retryAt.get(id) || 0)) return false;
      try { return this.register(this.peer.connect(id, { label: LABEL, reliable: true, serialization: 'json', metadata: { nexus: 1 } }), true).promise; }
      catch (_) { this.retryAt.set(id, Date.now() + 15000); return false; }
    }
    acceptConnection(connection) {
      if (connection.label !== LABEL || !/^nx-[a-f0-9]{32}$/.test(connection.peer) || this.store.blocked(connection.peer) || connection.peer === this.id) { connection.close(); return; }
      const existing = this.links.get(connection.peer);
      if (existing) {
        if (existing.authenticated || (existing.outgoing && this.id < connection.peer)) { connection.close(); return; }
        this.links.delete(connection.peer); existing.connection.close(); existing.resolve(false); clearTimeout(existing.timer);
      }
      this.register(connection, false);
    }
    register(connection, outgoing) {
      const record = { connection, outgoing, authenticated: false, nonce: M.uid(), remoteNonce: null, publicKey: null, person: null, chain: Promise.resolve(), received: 0, windowAt: Date.now() };
      record.promise = new Promise(resolve => { record.resolve = resolve; });
      this.links.set(connection.peer, record);
      record.timer = setTimeout(() => { if (!record.authenticated) { connection.close(); this.disconnected(connection.peer, record); } }, this.connectionTimeout);
      record.timer.unref?.();
      const hello = () => this.raw(record, { v: 1, type: 'hello', id: this.id, nonce: record.nonce, publicKey: this.identity.publicJwk, person: this.getProfile(), presence: this.store.state.preferences.presence });
      connection.on('open', hello);
      connection.on('data', frame => { record.chain = record.chain.then(() => this.receive(record, frame)).catch(() => { connection.close(); this.disconnected(connection.peer, record); }); });
      connection.on('close', () => this.disconnected(connection.peer, record));
      connection.on('error', () => { connection.close(); this.disconnected(connection.peer, record); });
      if (connection.open) queueMicrotask(hello);
      return record;
    }
    raw(record, frame) {
      if (!record?.connection.open) return false;
      try { record.connection.send(frame); return true; } catch (_) { return false; }
    }
    send(id, type, payload = {}, requestId) {
      const record = this.links.get(id);
      if (!record?.authenticated) return false;
      return this.raw(record, { v: 1, id: requestId || M.uid(), type, payload, q: !!requestId });
    }
    enqueue(id, type, payload, requestId = M.uid()) {
      this.store.queue(id, type, payload, requestId);
      if (this.isOnline(id)) this.flush(id); else this.connect(id).catch(() => {});
      return requestId;
    }
    flush(id) {
      if (!this.isOnline(id)) return;
      for (const item of this.store.state.outbox.filter(item => item.peer === id).slice(0, 20)) {
        if (Date.now() - (this.sent.get(item.id) || 0) < 4500) continue;
        if (this.send(id, item.type, item.payload, item.id)) this.sent.set(item.id, Date.now());
      }
    }
    disconnected(id, record) {
      clearTimeout(record.timer); record.resolve(false);
      if (this.links.get(id) !== record) return;
      this.links.delete(id); this.presence.delete(id); this.retryAt.set(id, Date.now() + 10000);
      for (const item of this.store.state.outbox.filter(item => item.peer === id)) this.sent.delete(item.id);
      for (const space of Object.values(this.store.state.spaces)) {
        if (space.owner === this.id && this.hostRoster(space.id).delete(id)) this.broadcastSpace(space.id);
      }
      if (this.voice?.kind === 'dm' && this.voice.peer === id) this.endCall('disconnected');
      if (this.pendingCall?.peer === id || this.outgoingCall?.peer === id) this.endCall('disconnected');
      this.emit('offline', { peer: id });
    }
    async receive(record, frame) {
      if (!frame || typeof frame !== 'object' || frame.v !== 1 || JSON.stringify(frame).length > MAX_FRAME) throw new Error('Invalid frame');
      if (Date.now() - record.windowAt > 10000) { record.windowAt = Date.now(); record.received = 0; }
      if (++record.received > 180) throw new Error('Rate limit');
      const remote = record.connection.peer;
      if (frame.type === 'hello') {
        if (record.remoteNonce || frame.id !== remote || !/^[A-Za-z0-9_-]{16,64}$/.test(frame.nonce || '')) throw new Error('Invalid hello');
        record.remoteNonce = frame.nonce; record.publicKey = frame.publicKey; record.person = M.profile(frame.person);
        record.presence = ['online', 'busy', 'away'].includes(frame.presence) ? frame.presence : 'online';
        const signature = await this.identity.sign(authText(this.id, remote, record.remoteNonce, record.nonce));
        this.raw(record, { v: 1, type: 'proof', signature }); return;
      }
      if (frame.type === 'proof') {
        if (record.authenticated) return;
        if (!record.remoteNonce || !await Identity.verify(remote, record.publicKey, authText(remote, this.id, record.nonce, record.remoteNonce), frame.signature)) throw new Error('Invalid identity');
        record.authenticated = true; clearTimeout(record.timer); record.resolve(true); this.retryAt.delete(remote);
        this.presence.set(remote, record.presence);
        const contact = this.store.contact(remote);
        if (contact && (contact.name !== record.person.name || contact.avatar !== record.person.avatar)) this.store.setContact(remote, contact.state, record.person);
        this.emit('online', { peer: remote, person: record.person }); this.flush(remote);
        for (const space of Object.values(this.store.state.spaces)) {
          if (space.owner === remote) this.send(remote, 'space-join', { space: space.id, token: space.invite.token });
          if (space.owner === this.id && space.members[remote] && !space.banned.includes(remote)) {
            this.hostRoster(space.id).set(remote, { id: remote, ...record.person, voice: null, muted: false, deafened: false, sharing: false });
            this.broadcastSpace(space.id);
          }
        }
        return;
      }
      if (!record.authenticated || !M.validId(frame.id) || typeof frame.type !== 'string' || !frame.payload || typeof frame.payload !== 'object' || Array.isArray(frame.payload)) throw new Error('Unauthenticated packet');
      if (frame.type === 'ack') { this.handleAck(remote, frame.payload); return; }
      const seenKey = remote + ':' + frame.id;
      if (this.seen.has(seenKey)) { if (frame.q) this.send(remote, 'ack', { id: frame.id, error: this.seen.get(seenKey) }); return; }
      let error = null;
      try { error = await this.route(remote, frame.type, frame.payload, record) || null; }
      catch (_) { error = 'Não foi possível processar esta ação.'; }
      this.seen.set(seenKey, error);
      if (this.seen.size > 5000) this.seen.delete(this.seen.keys().next().value);
      if (frame.q) this.send(remote, 'ack', { id: frame.id, error });
    }
    handleAck(remote, payload) {
      const item = this.store.state.outbox.find(value => value.id === payload.id && value.peer === remote);
      if (!item) return;
      if (item.type === 'dm-message') this.store.receipt('dm:' + remote, item.payload.id, payload.error ? 'failed' : 'delivered');
      if (item.type === 'space-message' && !payload.error) this.store.receipt('space:' + item.payload.space + ':' + item.payload.channel, item.payload.message.id, 'delivered');
      if (item.type === 'space-message' && payload.error) this.store.receipt('space:' + item.payload.space + ':' + item.payload.channel, item.payload.message.id, 'failed');
      this.store.acknowledge(item.id); this.sent.delete(item.id);
      if (payload.error) this.emit('notice', { message: M.text(payload.error, 200) });
    }
    async route(remote, type, payload, record) {
      switch (type) {
        case 'friend-request':
          if (this.store.blocked(remote) || !this.store.state.preferences.requests) return 'Esta pessoa não está recebendo solicitações.';
          if (this.store.accepted(remote)) { this.send(remote, 'friend-accept', this.getProfile()); return; }
          if (this.store.contact(remote)?.state === 'outgoing') { this.store.setContact(remote, 'accepted', record.person); this.enqueue(remote, 'friend-accept', this.getProfile()); }
          else { this.store.setContact(remote, 'incoming', record.person); this.emit('friend-request', { peer: remote }); }
          return;
        case 'friend-accept':
          if (['outgoing', 'accepted'].includes(this.store.contact(remote)?.state)) { this.store.setContact(remote, 'accepted', record.person); this.emit('friend-accepted', { peer: remote }); }
          return;
        case 'friend-cancel':
          if (this.store.contact(remote)?.state === 'incoming') this.store.setContact(remote, 'removed');
          return;
        case 'friend-reject':
          if (this.store.contact(remote)?.state === 'outgoing') this.store.setContact(remote, 'removed');
          return;
        case 'friend-remove': if (this.store.contact(remote)) { this.store.setContact(remote, 'removed', record.person); this.emit('friend-removed', { peer: remote }); } return;
        case 'profile':
          record.person = M.profile(payload.person); this.presence.set(remote, ['online', 'busy', 'away'].includes(payload.presence) ? payload.presence : 'online');
          if (this.store.contact(remote)) this.store.setContact(remote, this.store.contact(remote).state, record.person);
          for (const space of Object.values(this.store.state.spaces)) if (space.owner === this.id && space.members[remote]) {
            this.store.updateSpace(space.id, this.id, draft => { draft.members[remote] = record.person; });
            const member = this.hostRoster(space.id).get(remote); if (member) Object.assign(member, record.person);
            this.broadcastSpace(space.id);
          }
          this.emit('presence', { peer: remote }); return;
        case 'dm-message': {
          if (!this.store.accepted(remote)) return 'Adicione esta pessoa aos amigos antes de enviar mensagens.';
          const message = M.normalizeMessage({ ...payload, ...record.person, pinned: false, status: 'delivered' }, remote);
          if (!message) return 'Mensagem inválida.';
          const prior = this.store.messages('dm:' + remote).find(item => item.id === message.id);
          if (prior && prior.author !== remote) return 'Essa mensagem pertence a outra pessoa.';
          if (this.store.putMessage('dm:' + remote, message, remote)) this.emit('message', { scope: 'dm', peer: remote, message });
          return;
        }
        case 'dm-read':
          if (this.store.accepted(remote) && Array.isArray(payload.ids)) payload.ids.slice(0, 200).forEach(id => {
            if (this.store.messages('dm:' + remote).some(message => message.id === id && message.author === this.id)) this.store.receipt('dm:' + remote, id, 'read');
          });
          return;
        case 'typing': return this.receiveTyping(remote, payload);
        case 'space-join': return this.receiveJoin(remote, payload, record);
        case 'space-state': return this.receiveSpace(remote, payload);
        case 'space-rejected': {
          const pending = this.joining.get(payload.space);
          if (pending && pending.owner === remote) { clearTimeout(pending.timer); this.joining.delete(payload.space); pending.reject(new Error(M.text(payload.message, 200) || 'O convite não está disponível.')); }
          if (this.store.state.spaces[payload.space]?.owner === remote && ['missing', 'banned'].includes(payload.reason)) { if (this.voice?.space === payload.space) this.leaveVoice(); this.store.removeSpace(payload.space); this.rosters.delete(payload.space); this.emit('space-closed', { space: payload.space }); }
          return;
        }
        case 'space-leave': return this.receiveLeave(remote, payload);
        case 'space-closed':
          if (this.store.state.spaces[payload.space]?.owner === remote) { if (this.voice?.space === payload.space) this.leaveVoice(); this.store.removeSpace(payload.space); this.rosters.delete(payload.space); this.emit('space-closed', { space: payload.space }); }
          return;
        case 'space-message': return this.receiveSpaceMessage(remote, payload, record);
        case 'space-published': return this.receivePublished(remote, payload);
        case 'space-history': return this.sendHistory(remote, payload);
        case 'space-history-batch': return this.receiveHistory(remote, payload);
        case 'space-pin': return this.receivePin(remote, payload);
        case 'voice-join': return this.receiveVoiceJoin(remote, payload);
        case 'voice-leave': return this.receiveVoiceLeave(remote, payload);
        case 'voice-state': return this.receiveVoiceState(remote, payload);
        case 'call-invite': return this.receiveCall(remote, payload);
        case 'call-accept': return this.receiveCallAccept(remote, payload);
        case 'call-end': return this.receiveCallEnd(remote, payload);
        default: return 'Esta versão não reconhece a ação enviada.';
      }
    }
    requestFriend(id) {
      if (id === this.id) throw new Error('Esse é o seu próprio ID.');
      if (!/^nx-[a-f0-9]{32}$/.test(id)) throw new Error('Cole um ID de contato válido.');
      if (this.store.blocked(id)) throw new Error('Desbloqueie esta pessoa antes de enviar uma solicitação.');
      if (this.store.accepted(id)) throw new Error('Vocês já são amigos.');
      if (this.store.contact(id)?.state === 'incoming') { this.acceptFriend(id); return; }
      this.store.setContact(id, 'outgoing'); this.enqueue(id, 'friend-request', this.getProfile());
    }
    acceptFriend(id) { if (this.store.contact(id)?.state !== 'incoming') return; this.store.setContact(id, 'accepted'); this.enqueue(id, 'friend-accept', this.getProfile()); }
    rejectFriend(id) { if (this.store.contact(id)?.state !== 'incoming') return; this.store.setContact(id, 'removed'); this.enqueue(id, 'friend-reject', {}); }
    cancelRequest(id) { this.store.discardQueued(id, ['friend-request']); this.store.setContact(id, 'removed'); this.enqueue(id, 'friend-cancel', {}); }
    removeFriend(id) { this.store.setContact(id, 'removed'); this.store.discardQueued(id); this.enqueue(id, 'friend-remove', {}); if (this.voice?.peer === id) this.endCall('removed'); }
    block(id) { this.store.setContact(id, 'blocked'); this.store.discardQueued(id); if (this.voice?.peer === id || this.pendingCall?.peer === id || this.outgoingCall?.peer === id) this.endCall('blocked'); this.links.get(id)?.connection.close(); this.emit('blocked', { peer: id }); }
    unblock(id) { if (this.store.blocked(id)) this.store.setContact(id, 'removed'); }
    updateProfile() {
      this.links.forEach((record, id) => { if (record.authenticated) this.send(id, 'profile', { person: this.getProfile(), presence: this.store.state.preferences.presence }); });
      Object.values(this.store.state.spaces).filter(space => space.owner === this.id).forEach(space => {
        this.store.updateSpace(space.id, this.id, draft => { draft.members[this.id] = this.getProfile(); });
        const self = this.hostRoster(space.id).get(this.id); if (self) Object.assign(self, this.getProfile()); this.broadcastSpace(space.id);
      });
    }
    newMessage(value) { return { id: M.uid(), author: this.id, ...this.getProfile(), text: M.text(value), createdAt: Date.now(), revision: 0, status: 'queued' }; }
    sendDM(id, value, replyTo = null, invite = null) {
      if (!this.store.accepted(id) || this.store.blocked(id)) throw new Error('Adicione esta pessoa aos amigos para conversar.');
      const message = { ...this.newMessage(value), replyTo, invite };
      if (!message.text && !invite) throw new Error('Escreva uma mensagem antes de enviar.');
      this.store.putMessage('dm:' + id, message); this.enqueue(id, 'dm-message', message); return message;
    }
    editMessage(key, id, value, deleted = false) {
      const current = this.store.messages(key).find(message => message.id === id);
      if (!current || current.author !== this.id || current.deleted) throw new Error('Você só pode editar suas próprias mensagens.');
      const body = M.text(value);
      if (!deleted && !body) throw new Error('A mensagem não pode ficar vazia.');
      const message = { ...current, text: deleted ? '' : body, deleted, editedAt: Date.now(), revision: current.revision + 1, status: 'queued' };
      if (key.startsWith('dm:')) { const remote = key.slice(3); if (!this.store.accepted(remote)) throw new Error('Esta conversa não está ativa.'); this.store.putMessage(key, message); this.enqueue(remote, 'dm-message', message); }
      else { const [, space, channel] = key.split(':'); this.publishSpaceMessage(space, channel, message); }
    }
    readDM(id) {
      const key = 'dm:' + id; this.store.markRead(key, Math.max(Date.now(), ...this.store.messages(key).map(message => message.createdAt)));
      const ids = this.store.messages(key).filter(message => message.author === id).slice(-200).map(message => message.id);
      if (ids.length && this.isOnline(id)) this.send(id, 'dm-read', { ids });
    }
    sendTyping(scope, target, channel) {
      const key = [scope, target, channel || ''].join(':');
      if (Date.now() - (this.typingAt.get(key) || 0) < 1800) return;
      this.typingAt.set(key, Date.now());
      if (scope === 'dm' && this.store.accepted(target)) this.send(target, 'typing', { scope: 'dm' });
      if (scope === 'space') {
        const space = this.store.state.spaces[target]; if (!space) return;
        if (space.owner === this.id) this.broadcast(target, 'typing', { scope, space: target, channel, author: this.id, name: this.getProfile().name });
        else this.send(space.owner, 'typing', { scope, space: target, channel });
      }
    }
    receiveTyping(remote, payload) {
      if (payload.scope === 'dm' && this.store.accepted(remote)) this.emit('typing', { scope: 'dm', peer: remote, name: this.store.contact(remote).name });
      if (payload.scope === 'space') {
        const space = this.store.state.spaces[payload.space];
        if (!space || !space.channels.some(channel => channel.id === payload.channel && channel.type === 'text')) return;
        if (space.owner === this.id && space.members[remote] && this.hostRoster(space.id).has(remote)) {
          const detail = { scope: 'space', space: space.id, channel: payload.channel, author: remote, name: space.members[remote].name };
          this.broadcast(space.id, 'typing', detail, remote); this.emit('typing', detail);
        } else if (space.owner === remote && space.members[payload.author] && payload.author !== this.id) this.emit('typing', { scope: 'space', space: space.id, channel: payload.channel, author: payload.author, name: space.members[payload.author].name });
      }
    }

    createSpace(name) {
      const space = this.store.createSpace(this.id, this.getProfile(), name);
      this.hostRoster(space.id).set(this.id, { id: this.id, ...this.getProfile(), voice: null, muted: false, deafened: false, sharing: false });
      this.emit('spaces'); return space;
    }
    async joinInvite(value) {
      const invite = typeof value === 'string' ? M.parseInvite(value) : value;
      if (!invite) throw new Error('Cole um link de convite válido.');
      if (invite.owner === this.id) { if (this.store.state.spaces[invite.space]) return invite.space; throw new Error('Este espaço não está disponível neste perfil.'); }
      if (!await this.connect(invite.owner, true)) throw new Error('O anfitrião está offline. Peça para ele abrir o espaço e tente novamente.');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.joining.delete(invite.space); reject(new Error('O convite não foi aceito. Ele pode ter expirado ou sido renovado.')); }, 10000);
        this.joining.set(invite.space, { owner: invite.owner, resolve, reject, timer });
        this.send(invite.owner, 'space-join', { space: invite.space, token: invite.token });
      });
    }
    receiveJoin(remote, payload, record) {
      const space = this.store.state.spaces[payload.space];
      const reject = (message, reason = 'invite') => { this.send(remote, 'space-rejected', { space: payload.space, message, reason }); return message; };
      if (!space || space.owner !== this.id) return reject('Este espaço não está disponível.', 'missing');
      if (space.banned.includes(remote)) return reject('Este espaço não está disponível.', 'banned');
      if (!space.members[remote] && (space.invite.token !== payload.token || (space.invite.expiresAt && Date.now() > space.invite.expiresAt))) return reject('O convite expirou ou foi renovado.');
      if (!space.members[remote] && Object.keys(space.members).length >= 128) return reject('Este espaço atingiu o limite de participantes.');
      this.store.updateSpace(space.id, this.id, draft => { draft.members[remote] = record.person; });
      const prior = this.hostRoster(space.id).get(remote);
      this.hostRoster(space.id).set(remote, { ...prior, id: remote, ...record.person, voice: prior?.voice || null, muted: !!prior?.muted, deafened: !!prior?.deafened, sharing: !!prior?.sharing });
      this.broadcastSpace(space.id); this.sendHistory(remote, { space: space.id, channel: space.channels.find(channel => channel.type === 'text')?.id });
      this.emit('member-joined', { space: space.id, peer: remote });
    }
    receiveSpace(remote, payload) {
      const space = M.normalizeSpace(payload.space);
      if (!space || space.owner !== remote || !space.members[this.id] || !Array.isArray(payload.roster) || payload.roster.length > 128) return 'Espaço inválido.';
      this.store.upsertSpace(space);
      const roster = new Map();
      for (const member of payload.roster) if (space.members[member.id]) roster.set(member.id, { id: member.id, ...space.members[member.id], voice: space.channels.some(channel => channel.type === 'voice' && channel.id === member.voice) ? member.voice : null, muted: !!member.muted, deafened: !!member.deafened, sharing: !!member.sharing });
      this.rosters.set(space.id, roster);
      const pending = this.joining.get(space.id);
      if (pending) { clearTimeout(pending.timer); this.joining.delete(space.id); pending.resolve(space.id); }
      if (this.voice?.space === space.id) {
        if (!space.channels.some(channel => channel.id === this.voice.channel) || !roster.has(this.id)) this.leaveVoice();
        else if (roster.get(this.id).voice === this.voice.channel) { this.voice.confirmed = true; clearTimeout(this.voiceTimer); this.emit('voice-roster'); }
        else if (this.voice.confirmed) { this.emit('voice-rejected', { message: 'Você saiu deste canal de voz.' }); this.leaveVoice(); }
      }
      this.emit('space-state', { space: space.id });
    }
    broadcast(spaceId, type, payload, except) {
      const space = this.store.state.spaces[spaceId];
      if (!space || space.owner !== this.id) return;
      for (const member of this.hostRoster(spaceId).keys()) if (member !== this.id && member !== except && space.members[member]) this.send(member, type, payload);
    }
    broadcastSpace(spaceId) {
      const space = this.store.state.spaces[spaceId];
      this.broadcast(spaceId, 'space-state', { space, roster: this.roomRoster(spaceId) });
      this.emit('space-state', { space: spaceId });
      if (this.voice?.space === spaceId) this.emit('voice-roster');
    }
    configureSpace(id, changes) {
      const updated = this.store.updateSpace(id, this.id, space => { if (changes.name !== undefined) space.name = M.text(changes.name, 48); if (changes.topic !== undefined) space.topic = M.text(changes.topic, 160); });
      this.broadcastSpace(id); return updated;
    }
    addChannel(id, name, type) {
      if (!['text', 'voice'].includes(type) || !M.text(name, 32)) throw new Error('Dê um nome ao canal.');
      const channel = { id: M.uid(), name: M.text(name, 32), type, topic: '' };
      this.store.updateSpace(id, this.id, space => { if (space.channels.length >= 64) throw new Error('Este espaço já tem 64 canais.'); space.channels.push(channel); });
      this.broadcastSpace(id); return channel;
    }
    configureChannel(spaceId, channelId, { name, topic, remove = false }) {
      this.store.updateSpace(spaceId, this.id, space => {
        const channel = space.channels.find(item => item.id === channelId);
        if (!channel) throw new Error('Canal não encontrado.');
        if (remove) {
          if (channel.type === 'text' && space.channels.filter(item => item.type === 'text').length === 1) throw new Error('Mantenha pelo menos um canal de texto.');
          space.channels = space.channels.filter(item => item.id !== channelId);
        } else { if (M.text(name, 32)) channel.name = M.text(name, 32); channel.topic = M.text(topic, 160); }
      });
      if (remove) { this.hostRoster(spaceId).forEach(member => { if (member.voice === channelId) member.voice = null; }); if (this.voice?.space === spaceId && this.voice.channel === channelId) this.leaveVoice(); }
      this.broadcastSpace(spaceId);
    }
    renewInvite(spaceId, expiresIn = 0) {
      const space = this.store.updateSpace(spaceId, this.id, room => { room.invite = { token: M.uid().replaceAll('-', ''), expiresAt: expiresIn ? Date.now() + expiresIn : 0 }; });
      this.broadcastSpace(spaceId); return space;
    }
    leaveSpace(spaceId) {
      const space = this.store.state.spaces[spaceId]; if (!space) return;
      if (space.owner === this.id) throw new Error('O anfitrião deve encerrar o espaço nas configurações.');
      if (this.voice?.space === spaceId) this.leaveVoice();
      this.send(space.owner, 'space-leave', { space: spaceId }); this.store.removeSpace(spaceId); this.rosters.delete(spaceId); this.emit('spaces');
    }
    closeSpace(spaceId) {
      if (!this.canManage(spaceId)) throw new Error('Só o anfitrião pode encerrar este espaço.');
      this.broadcast(spaceId, 'space-closed', { space: spaceId });
      if (this.voice?.space === spaceId) this.leaveVoice();
      this.store.removeSpace(spaceId); this.rosters.delete(spaceId); this.emit('spaces');
    }
    receiveLeave(remote, payload) {
      const space = this.store.state.spaces[payload.space]; if (!space || space.owner !== this.id || remote === this.id) return;
      this.store.updateSpace(space.id, this.id, draft => { delete draft.members[remote]; }); this.hostRoster(space.id).delete(remote); this.broadcastSpace(space.id);
    }
    sendSpaceMessage(spaceId, channelId, value, replyTo = null) {
      const message = { ...this.newMessage(value), replyTo };
      if (!message.text) throw new Error('Escreva uma mensagem antes de enviar.');
      this.publishSpaceMessage(spaceId, channelId, message); return message;
    }
    publishSpaceMessage(spaceId, channelId, message) {
      const space = this.store.state.spaces[spaceId];
      if (!space?.members[this.id] || !space.channels.some(channel => channel.id === channelId && channel.type === 'text')) throw new Error('Este canal não está disponível.');
      if (space.owner === this.id) {
        const prior = this.store.messages('space:' + spaceId + ':' + channelId).find(item => item.id === message.id);
        this.acceptSpaceMessage(space, channelId, { ...message, pinned: prior?.pinned || false, status: 'delivered' }, this.id);
      } else {
        this.store.putMessage('space:' + spaceId + ':' + channelId, message);
        this.enqueue(space.owner, 'space-message', { space: spaceId, channel: channelId, message });
      }
    }
    receiveSpaceMessage(remote, payload, record) {
      const space = this.store.state.spaces[payload.space];
      if (!space || space.owner !== this.id || !space.members[remote] || !this.hostRoster(space.id).has(remote) || !space.channels.some(channel => channel.id === payload.channel && channel.type === 'text')) return 'Este canal não está disponível.';
      const key = 'space:' + space.id + ':' + payload.channel;
      const prior = this.store.messages(key).find(message => message.id === payload.message?.id);
      if (prior && prior.author !== remote) return 'Você só pode editar suas próprias mensagens.';
      const message = M.normalizeMessage({ ...payload.message, ...record.person, status: 'delivered', pinned: prior?.pinned || false }, remote);
      if (!message) return 'Mensagem inválida.';
      this.acceptSpaceMessage(space, payload.channel, message, remote);
    }
    acceptSpaceMessage(space, channelId, message, author) {
      const key = 'space:' + space.id + ':' + channelId;
      if (this.store.putMessage(key, message, author)) {
        this.broadcast(space.id, 'space-published', { space: space.id, channel: channelId, message });
        this.emit('message', { scope: 'space', space: space.id, channel: channelId, message });
      }
    }
    receivePublished(remote, payload) {
      const space = this.store.state.spaces[payload.space];
      if (!space || space.owner !== remote || !space.channels.some(channel => channel.id === payload.channel && channel.type === 'text')) return;
      const message = M.normalizeMessage({ ...payload.message, status: 'delivered' }); if (!message) return;
      const key = 'space:' + space.id + ':' + payload.channel;
      const added = this.store.putMessage(key, message);
      if (message.author === this.id) this.store.receipt(key, message.id, 'delivered');
      if (added) this.emit('message', { scope: 'space', space: space.id, channel: payload.channel, message });
    }
    requestHistory(spaceId, channel, before = 0) {
      const space = this.store.state.spaces[spaceId];
      if (space && space.owner !== this.id) this.send(space.owner, 'space-history', { space: spaceId, channel, before });
    }
    sendHistory(remote, payload) {
      const space = this.store.state.spaces[payload.space];
      if (!space || space.owner !== this.id || !space.members[remote] || !this.hostRoster(space.id).has(remote) || !space.channels.some(channel => channel.id === payload.channel && channel.type === 'text')) return;
      const messages = this.store.messages('space:' + space.id + ':' + payload.channel).filter(message => !payload.before || message.createdAt < payload.before).slice(-50);
      for (let offset = 0; offset < messages.length; offset += 5) this.send(remote, 'space-history-batch', { space: space.id, channel: payload.channel, messages: messages.slice(offset, offset + 5) });
      this.send(remote, 'space-history-batch', { space: space.id, channel: payload.channel, messages: [], done: true, more: messages.length === 50 });
    }
    receiveHistory(remote, payload) {
      const space = this.store.state.spaces[payload.space];
      if (!space || space.owner !== remote || !space.channels.some(channel => channel.id === payload.channel && channel.type === 'text') || !Array.isArray(payload.messages) || payload.messages.length > 5) return;
      for (const value of payload.messages) {
        const message = M.normalizeMessage(value); if (message) this.store.putMessage('space:' + space.id + ':' + payload.channel, message);
      }
      this.emit('history', { space: space.id, channel: payload.channel, done: !!payload.done, more: !!payload.more });
    }
    pin(spaceId, channel, id) {
      if (!this.canManage(spaceId)) throw new Error('Só o anfitrião pode fixar mensagens neste espaço.');
      return this.receivePin(this.id, { space: spaceId, channel, id });
    }
    receivePin(remote, payload) {
      const space = this.store.state.spaces[payload.space];
      if (!space || space.owner !== this.id || remote !== this.id) return 'Só o anfitrião pode fixar mensagens.';
      const message = this.store.messages('space:' + space.id + ':' + payload.channel).find(item => item.id === payload.id);
      if (message && !message.deleted) this.acceptSpaceMessage(space, payload.channel, { ...message, pinned: !message.pinned, revision: message.revision + 1 }, message.author);
    }

    joinVoice(spaceId, channel) {
      const space = this.store.state.spaces[spaceId];
      if (!space || !space.channels.some(item => item.id === channel && item.type === 'voice') || !this.roomOnline(spaceId)) throw new Error('O anfitrião precisa estar conectado para entrar na voz.');
      if (this.voice) this.leaveVoice();
      this.voice = { kind: 'space', space: spaceId, channel, session: 'space:' + spaceId + ':' + channel, startedAt: Date.now(), confirmed: space.owner === this.id };
      if (space.owner === this.id) this.receiveVoiceJoin(this.id, { space: spaceId, channel });
      else {
        this.send(space.owner, 'voice-join', { space: spaceId, channel });
        this.voiceTimer = setTimeout(() => { if (this.voice?.space === spaceId && !this.voice.confirmed) { this.emit('voice-rejected', { message: 'O canal de voz não respondeu. Tente novamente.' }); this.leaveVoice(); } }, 10000);
        this.voiceTimer.unref?.();
      }
      this.emit('voice-roster');
    }
    receiveVoiceJoin(remote, payload) {
      const space = this.store.state.spaces[payload.space];
      if (!space || space.owner !== this.id || !space.members[remote] || !this.hostRoster(space.id).has(remote) || !space.channels.some(channel => channel.id === payload.channel && channel.type === 'voice')) return;
      const roster = this.hostRoster(space.id);
      if (this.roomRoster(space.id).filter(member => member.voice === payload.channel).length >= 16 && roster.get(remote).voice !== payload.channel) { this.send(remote, 'voice-state', { rejected: true, message: 'Este canal já tem 16 conexões de voz.' }); return; }
      roster.get(remote).voice = payload.channel; roster.get(remote).sharing = false; this.broadcastSpace(space.id);
    }
    receiveVoiceLeave(remote, payload) {
      const space = this.store.state.spaces[payload.space]; if (!space || space.owner !== this.id) return;
      const member = this.hostRoster(space.id).get(remote); if (member) { member.voice = null; member.sharing = false; this.broadcastSpace(space.id); }
    }
    leaveVoice() {
      clearTimeout(this.voiceTimer);
      const previous = this.voice; this.voice = null;
      if (!previous) return;
      if (previous.kind === 'space') {
        const room = this.store.state.spaces[previous.space];
        if (room?.owner === this.id) this.receiveVoiceLeave(this.id, { space: previous.space });
        else if (room) this.send(room.owner, 'voice-leave', { space: previous.space });
      } else this.send(previous.peer, 'call-end', { id: previous.session, reason: 'ended' });
      this.emit('voice-left', { previous });
    }
    voiceTargets() {
      if (!this.voice) return [];
      if (this.voice.kind === 'dm') return [this.voice.peer];
      const roster = this.rosters.get(this.voice.space);
      if (roster?.get(this.id)?.voice !== this.voice.channel) return [];
      return [...roster.values()].filter(member => member.id !== this.id && member.voice === this.voice.channel).map(member => member.id);
    }
    initiatesMedia(id) { return this.voice?.kind === 'dm' ? this.voice.initiator === this.id : this.id < id; }
    mediaAllowed(id, metadata) { return !!this.voice && metadata?.nexusVoice === 1 && metadata.session === this.voice.session && this.isOnline(id) && this.voiceTargets().includes(id); }
    voiceMember(id) {
      if (id === this.id) return this.getProfile();
      return this.voice?.kind === 'space' ? this.rosters.get(this.voice.space)?.get(id) : this.store.contact(id);
    }
    voiceState(state) {
      if (!this.voice) return;
      const clean = { muted: !!state.muted, deafened: !!state.deafened, sharing: !!state.sharing };
      if (this.voice.kind === 'dm') this.send(this.voice.peer, 'voice-state', { session: this.voice.session, ...clean });
      else {
        const room = this.store.state.spaces[this.voice.space];
        if (room?.owner === this.id) this.receiveVoiceState(this.id, { space: room.id, ...clean });
        else if (room) this.send(room.owner, 'voice-state', { space: room.id, ...clean });
      }
    }
    receiveVoiceState(remote, payload) {
      if (payload.rejected && this.voice?.kind === 'space' && this.store.state.spaces[this.voice.space]?.owner === remote) { this.emit('voice-rejected', { message: M.text(payload.message, 200) }); this.leaveVoice(); return; }
      if (this.voice?.kind === 'dm' && this.voice.peer === remote && this.voice.session === payload.session) { this.emit('media-state', { peer: remote, sharing: !!payload.sharing, muted: !!payload.muted, deafened: !!payload.deafened }); return; }
      const room = this.store.state.spaces[payload.space];
      if (room?.owner === this.id) {
        const member = this.hostRoster(room.id).get(remote);
        if (member?.voice) { member.muted = !!payload.muted; member.deafened = !!payload.deafened; member.sharing = !!payload.sharing; this.broadcastSpace(room.id); }
      }
    }
    async startCall(id) {
      if (!this.store.accepted(id)) throw new Error('Adicione esta pessoa aos amigos para ligar.');
      if (this.voice || this.pendingCall || this.outgoingCall) throw new Error('Encerre a chamada atual antes de iniciar outra.');
      if (!await this.connect(id, true)) throw new Error('Esta pessoa está offline. Tente novamente quando ela voltar.');
      const call = { id: M.uid(), peer: id, createdAt: Date.now() }; this.outgoingCall = call;
      this.send(id, 'call-invite', { id: call.id }); this.emit('call-ringing', { call });
      this.callTimer = setTimeout(() => this.endCall('unanswered'), 30000); this.callTimer.unref?.(); return call;
    }
    receiveCall(remote, payload) {
      if (!M.validId(payload.id)) return;
      if (!this.store.accepted(remote) || this.voice || this.pendingCall || this.outgoingCall || this.store.state.preferences.presence === 'busy') { this.send(remote, 'call-end', { id: payload.id, reason: 'busy' }); return; }
      this.pendingCall = { id: payload.id, peer: remote, createdAt: Date.now() }; this.emit('incoming-call', { call: this.pendingCall });
      this.callTimer = setTimeout(() => this.endCall('unanswered'), 30000); this.callTimer.unref?.();
    }
    acceptCall() {
      const call = this.pendingCall;
      if (!call || !this.store.accepted(call.peer)) return false;
      clearTimeout(this.callTimer); this.pendingCall = null;
      this.voice = { kind: 'dm', peer: call.peer, session: call.id, initiator: call.peer, startedAt: Date.now() };
      this.send(call.peer, 'call-accept', { id: call.id }); this.emit('voice-roster'); this.emit('call-accepted', { call }); return true;
    }
    receiveCallAccept(remote, payload) {
      const call = this.outgoingCall;
      if (!call || call.peer !== remote || call.id !== payload.id) return;
      clearTimeout(this.callTimer); this.outgoingCall = null;
      this.voice = { kind: 'dm', peer: remote, session: call.id, initiator: this.id, startedAt: Date.now() };
      this.emit('call-accepted', { call }); this.emit('voice-roster');
    }
    receiveCallEnd(remote, payload) {
      const matches = (this.pendingCall?.peer === remote && this.pendingCall.id === payload.id) || (this.outgoingCall?.peer === remote && this.outgoingCall.id === payload.id) || (this.voice?.peer === remote && this.voice.session === payload.id);
      if (matches) this.endCall(['busy', 'declined', 'unanswered'].includes(payload.reason) ? payload.reason : 'ended', false);
    }
    endCall(reason = 'ended', notify = true) {
      clearTimeout(this.callTimer);
      const call = this.pendingCall || this.outgoingCall || (this.voice?.kind === 'dm' ? { id: this.voice.session, peer: this.voice.peer } : null);
      this.pendingCall = this.outgoingCall = null;
      if (call && notify) this.send(call.peer, 'call-end', { id: call.id, reason });
      if (this.voice?.kind === 'dm') { const previous = this.voice; this.voice = null; this.emit('voice-left', { previous }); }
      this.emit('call-ended', { reason, call });
    }
    tick() {
      if (!this.ready) return;
      const peers = new Set(this.store.state.outbox.map(item => item.peer));
      Object.values(this.store.state.contacts).filter(contact => ['accepted', 'outgoing', 'incoming'].includes(contact.state)).forEach(contact => peers.add(contact.id));
      Object.values(this.store.state.spaces).forEach(space => { if (space.owner !== this.id) peers.add(space.owner); else Object.keys(space.members).forEach(id => peers.add(id)); });
      peers.forEach(id => { if (this.isOnline(id)) this.flush(id); else this.connect(id).catch(() => {}); });
    }
    destroy() {
      this.ready = false; clearInterval(this.interval); clearTimeout(this.callTimer); clearTimeout(this.voiceTimer);
      for (const pending of this.joining.values()) { clearTimeout(pending.timer); pending.reject(new Error('Conexão encerrada.')); }
      this.joining.clear(); this.links.forEach(record => { clearTimeout(record.timer); record.resolve(false); record.connection.close(); }); this.links.clear();
    }
  }
  return { Client, LABEL, authText };
});
