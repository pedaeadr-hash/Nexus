/* Rendering uses text nodes for all peer-supplied content. */
(function () {
  'use strict';
  const M = window.NexusModel;
  const $ = id => document.getElementById(id);
  const make = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
  const icon = name => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); element.classList.add('icon'); element.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', '#i-' + name); element.append(use); return element;
  };
  const button = (label, symbol, action, className = 'icon-button') => {
    const element = make('button', className); element.type = 'button'; element.setAttribute('aria-label', label); element.title = label;
    if (symbol) element.append(icon(symbol)); if (className !== 'icon-button' && !className.includes('icon-only')) element.append(make('span', '', label));
    element.addEventListener('click', action); return element;
  };
  const statusNames = { online: 'Disponível', busy: 'Não perturbe', away: 'Ausente', offline: 'Offline' };
  const avatar = (person, className = '') => { const element = make('span', className); renderAvatar(element, person?.avatar, person?.name); element.setAttribute('aria-hidden', 'true'); return element; };
  const time = value => new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  const date = value => new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long' }).format(new Date(value));

  class Community {
    constructor() {
      this.store = new M.Store(localStorage, statusMsg); this.client = null; this.identity = null;
      this.activeDM = null; this.activeSpace = null; this.activeChannel = null; this.friendsFilter = 'all';
      this.reply = {}; this.drafts = new Map(); this.messageSignatures = {}; this.limits = {}; this.bookmarkFilters = {}; this.pinFilter = false; this.typingTimers = new Map(); this.signatures = {};
      this.dialogTriggers = new Map(); this.renderQueued = false; this.voiceRevision = 0; this.closingVoice = false;
      this.store.subscribe(() => this.scheduleRender());
      this.interval = setInterval(() => this.renderVoiceDock(), 1000);
      this.render();
    }
    me() { return this.client?.id || this.identity?.id || ''; }
    ready() { if (!this.client) { statusMsg('Estamos preparando seu perfil. Aguarde um instante.'); return false; } return true; }
    async boot() {
      try {
        this.identity = await NexusIdentity.open();
        this.client = new NexusSocial.Client({ store: this.store, identity: this.identity, person: () => profile });
        this.client.on(event => this.handleEvent(event));
        $('myContactId').value = this.identity.id; $('sidebarMyid').textContent = this.identity.id;
        this.installHandlers(); this.render(); initializePeer(this.identity.id);
      } catch (error) { updateNetworkStatus('bad', 'Perfil indisponível'); statusMsg(error.message || 'Não foi possível preparar seu perfil.'); }
    }
    peerReady(driver) {
      this.client?.attachPeer(driver); this.render();
      if (this.readUrl) return; this.readUrl = true;
      const params = new URLSearchParams(location.search);
      const contact = M.parseContact(params.get('friend') || '');
      if (contact && contact !== this.me()) { $('friendIdInput').value = contact; setView('friends'); $('friendIdInput').focus(); }
      else if (M.parseInvite(location.href)) this.openJoinDialog(location.href);
    }
    scheduleRender() {
      if (this.renderQueued) return; this.renderQueued = true;
      queueMicrotask(() => { this.renderQueued = false; this.render(); });
    }
    currentView() { return document.querySelector('.view.active')?.id.slice(5) || 'home'; }
    onView(view) {
      document.body.dataset.view = view;
      if (view === 'friends') this.renderFriends();
      if (view === 'dm') this.renderDM();
      if (view === 'space') this.renderSpace();
      if (view === 'dm' || view === 'space') this.composerSize(view);
      this.markActiveRead(); this.renderVoiceDock();
    }
    threadKey(scope) { return scope === 'dm' && this.activeDM ? 'dm:' + this.activeDM : scope === 'space' && this.activeSpace && this.activeChannel ? 'space:' + this.activeSpace + ':' + this.activeChannel : null; }
    render() {
      this.renderBadges(); this.renderSpaces(); this.renderFriends(); this.renderThreads(); this.renderDM(); this.renderSpace(); this.renderVoiceDock();
      if ($('friendRequestsCheck')) $('friendRequestsCheck').checked = this.store.state.preferences.requests;
    }
    renderBadges() {
      const contacts = Object.values(this.store.state.contacts);
      const requests = contacts.filter(contact => contact.state === 'incoming').length;
      const unread = contacts.filter(contact => contact.state !== 'blocked').reduce((total, contact) => total + this.store.unread('dm:' + contact.id, this.me()), 0);
      $('friendRequestCount').hidden = !requests; $('friendRequestCount').textContent = String(requests);
      $('dmUnreadCount').hidden = !unread; $('dmUnreadCount').textContent = unread > 99 ? '99+' : String(unread);
      $('requestsTabCount').textContent = requests ? String(requests) : '';
      document.title = (unread + requests ? '(' + (unread + requests) + ') ' : '') + 'Nexus — por perto.';
    }
    empty(title, description, symbol, action, actionLabel) {
      const element = make('div', 'social-empty'); const visual = make('div', 'empty-symbol'); visual.append(icon(symbol));
      element.append(visual, make('h2', '', title), make('p', '', description));
      if (action) element.append(button(actionLabel, 'arrow', action, 'secondary'));
      return element;
    }
    renderSpaces() {
      const spaces = Object.values(this.store.state.spaces).sort((a, b) => a.createdAt - b.createdAt);
      const signature = spaces.map(space => [space.id, space.revision, this.client?.roomOnline(space.id), this.client?.roomRoster(space.id).length, this.activeSpace].join(':')).join('|');
      if (signature === this.signatures.spaces) return; this.signatures.spaces = signature;
      const side = $('sidebarSpaces'); const grid = $('spacesList'); const home = $('homeSpacesStrip');
      side.replaceChildren(); grid.replaceChildren(); home.replaceChildren(); home.hidden = !spaces.length;
      if (!spaces.length) {
        grid.append(this.empty('Todo grupo merece um lugar.', 'Crie um espaço com canais de texto e voz, ou entre pelo convite de alguém.', 'spaces', () => this.openSpaceDialog(), 'Criar meu primeiro espaço'));
        side.append(make('span', 'sidebar-space-empty', 'Sua próxima conversa começa em um novo espaço.'));
      }
      for (const space of spaces) {
        const initials = profileInitials(space.name); const online = this.client?.roomOnline(space.id);
        const shortcut = make('button', 'space-shortcut' + (this.activeSpace === space.id && this.currentView() === 'space' ? ' active' : ''));
        shortcut.title = space.name; shortcut.append(make('span', 'space-monogram', initials), make('span', 'space-shortcut-name', space.name)); shortcut.addEventListener('click', () => this.openSpace(space.id)); side.append(shortcut);
        const card = make('article', 'space-card'); const top = make('div', 'space-card-top'); const state = make('span', 'space-card-state', online ? 'ABERTO' : 'ANFITRIÃO OFFLINE'); state.dataset.online = String(!!online);
        top.append(make('span', 'space-monogram large', initials), state);
        card.append(top, make('h2', '', space.name), make('p', '', space.topic || 'Um espaço para deixar a conversa acontecer.'));
        const meta = make('div', 'space-card-meta', space.channels.filter(channel => channel.type === 'text').length + ' texto · ' + space.channels.filter(channel => channel.type === 'voice').length + ' voz');
        card.append(meta, button('Abrir espaço', 'arrow', () => this.openSpace(space.id), 'secondary')); grid.append(card);
        if (home.children.length < 4) { const pill = make('button', 'home-space-pill'); pill.append(make('span', 'space-monogram', initials), make('span', '', space.name), icon('diagonal')); pill.addEventListener('click', () => this.openSpace(space.id)); home.append(pill); }
      }
    }
    setFriendsFilter(filter) {
      this.friendsFilter = filter;
      ['all', 'online', 'requests', 'blocked'].forEach(value => { const tab = $('friends-' + value); const selected = value === filter; tab.classList.toggle('active', selected); tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; });
      $('friendsList').setAttribute('aria-labelledby', 'friends-' + filter); this.signatures.friends = ''; this.renderFriends();
    }
    renderFriends() {
      const filter = this.friendsFilter; const search = $('friendSearch').value.trim().toLocaleLowerCase('pt-BR');
      let contacts = Object.values(this.store.state.contacts).filter(contact => filter === 'requests' ? ['incoming', 'outgoing'].includes(contact.state) : filter === 'blocked' ? contact.state === 'blocked' : contact.state === 'accepted');
      if (filter === 'online') contacts = contacts.filter(contact => this.client?.isOnline(contact.id));
      if (search) contacts = contacts.filter(contact => (contact.name + ' ' + contact.id).toLocaleLowerCase('pt-BR').includes(search));
      contacts.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
      const signature = filter + search + contacts.map(contact => [contact.id, contact.state, contact.name, contact.avatar, this.client?.status(contact.id)].join(':')).join('|');
      if (signature === this.signatures.friends) return; this.signatures.friends = signature;
      const list = $('friendsList'); list.replaceChildren();
      if (!contacts.length) {
        const copy = search ? ['Nenhum contato por esse nome.', 'Tente buscar pelo nome ou pelo ID.'] : filter === 'requests' ? ['Tudo em dia por aqui.', 'As solicitações recebidas e enviadas aparecem aqui.'] : filter === 'blocked' ? ['Nenhum contato bloqueado.', 'Você decide quem pode fazer parte da sua conversa.'] : filter === 'online' ? ['Sua gente está offline.', 'As mensagens ficam na fila até vocês se encontrarem por aqui.'] : ['Toda amizade começa com um oi.', 'Adicione alguém pelo ID ou compartilhe seu link de contato.'];
        list.append(this.empty(copy[0], copy[1], 'friends')); return;
      }
      for (const person of contacts) {
        const row = make('article', 'friend-row'); const image = make('div', 'friend-avatar'); const dot = make('span', 'presence-dot'); dot.dataset.status = this.client?.status(person.id) || 'offline'; image.append(avatar(person), dot);
        const info = make('div', 'friend-info'); info.append(make('h3', '', person.name), make('p', '', person.state === 'incoming' ? 'Quer fazer parte da sua gente.' : person.state === 'outgoing' ? 'Solicitação enviada · aguardando resposta' : person.state === 'blocked' ? 'Contato bloqueado' : statusNames[this.client?.status(person.id) || 'offline']));
        const actions = make('div', 'friend-actions');
        if (person.state === 'incoming') { actions.append(button('Aceitar solicitação de ' + person.name, 'check', () => this.client.acceptFriend(person.id)), button('Recusar solicitação de ' + person.name, 'close', () => this.client.rejectFriend(person.id))); }
        else if (person.state === 'outgoing') actions.append(button('Cancelar solicitação para ' + person.name, 'close', () => this.client.cancelRequest(person.id)));
        else if (person.state === 'blocked') actions.append(button('Desbloquear', null, () => this.client.unblock(person.id), 'secondary'));
        else {
          actions.append(button('Conversar com ' + person.name, 'chat', () => this.openDM(person.id)));
          const call = button('Ligar para ' + person.name, 'phone', () => this.startDMCall(person.id)); call.disabled = !this.client?.isOnline(person.id); actions.append(call);
          actions.append(button('Opções de ' + person.name, 'settings', () => this.openContactMenu(person.id)));
        }
        row.append(image, info, actions); list.append(row);
      }
    }
    openDM(id) {
      if (!this.store.contact(id)) { setView('friends'); $('friendIdInput').value = id; $('friendIdInput').focus(); statusMsg('Envie uma solicitação de amizade para começar esta conversa.'); return; }
      this.rememberDraft('dm'); this.activeDM = id; this.messageSignatures.dm = ''; this.bookmarkFilters.dm = false;
      $('dmMessageSearch').value = ''; this.renderDM(); this.restoreDraft('dm'); setView('dm'); this.client?.connect(id).catch(() => {}); this.markActiveRead();
    }
    closeDM() { this.rememberDraft('dm'); this.activeDM = null; this.renderDM(); }
    renderThreads() {
      const people = Object.values(this.store.state.contacts).filter(person => person.state !== 'blocked' && (person.state === 'accepted' || this.store.messages('dm:' + person.id).length));
      people.sort((a, b) => (this.store.messages('dm:' + b.id).at(-1)?.createdAt || b.updatedAt) - (this.store.messages('dm:' + a.id).at(-1)?.createdAt || a.updatedAt));
      const signature = people.map(person => [person.id, person.name, person.avatar, this.client?.status(person.id), this.store.messages('dm:' + person.id).at(-1)?.id, this.store.messages('dm:' + person.id).at(-1)?.revision, this.store.unread('dm:' + person.id, this.me()), this.activeDM].join(':')).join('|');
      if (signature === this.signatures.threads) return; this.signatures.threads = signature;
      const list = $('dmThreads'); list.replaceChildren();
      if (!people.length) list.append(make('p', 'thread-list-empty', 'Adicione um amigo para começar.'));
      for (const person of people) {
        const entry = make('button', 'dm-thread' + (this.activeDM === person.id ? ' active' : '')); entry.setAttribute('aria-label', 'Conversa com ' + person.name);
        const image = make('span', 'thread-avatar'); const dot = make('span', 'presence-dot'); dot.dataset.status = this.client?.status(person.id) || 'offline'; image.append(avatar(person), dot);
        const content = make('span', 'thread-copy'); const last = this.store.messages('dm:' + person.id).at(-1); content.append(make('b', '', person.name), make('span', '', last ? last.deleted ? 'Mensagem removida' : last.invite ? 'Convite para um espaço' : last.text : 'Dê o primeiro oi.'));
        entry.append(image, content); const unread = this.store.unread('dm:' + person.id, this.me()); if (unread) entry.append(make('span', 'count-badge', unread > 99 ? '99+' : String(unread)));
        entry.addEventListener('click', () => this.openDM(person.id)); list.append(entry);
      }
    }
    renderDM() {
      const person = this.store.contact(this.activeDM); const active = !!person;
      $('dmChat').hidden = !active; $('dmEmpty').hidden = active; $('dmShell').classList.toggle('has-thread', active);
      if (!active) return;
      renderAvatar($('dmPeerAvatar'), person.avatar, person.name); $('dmPeerName').textContent = person.name;
      const status = this.client?.status(person.id) || 'offline'; $('dmPeerStatus').textContent = statusNames[status]; $('dmPeerStatus').dataset.status = status;
      $('dmCallBtn').disabled = !this.client?.isOnline(person.id) || person.state !== 'accepted';
      const note = $('dmConnectionNote'); note.hidden = status !== 'offline' && person.state === 'accepted';
      note.textContent = person.state === 'blocked' ? 'Este contato está bloqueado.' : person.state !== 'accepted' ? 'Adicione esta pessoa aos amigos para continuar a conversa.' : 'Seu amigo está offline. As mensagens ficam na fila até vocês estarem conectados.';
      $('dmComposer').disabled = person.state !== 'accepted'; $('dmChat').querySelector('.send-button').disabled = person.state !== 'accepted';
      this.renderChat('dm');
    }
    openSpace(id, channel) {
      const space = this.store.state.spaces[id]; if (!space) return;
      this.rememberDraft('space'); this.activeSpace = id;
      this.activeChannel = space.channels.some(item => item.id === channel && item.type === 'text') ? channel : this.activeSpace === id && space.channels.some(item => item.id === this.activeChannel && item.type === 'text') ? this.activeChannel : space.channels.find(item => item.type === 'text')?.id;
      this.pinFilter = false; this.messageSignatures.space = ''; $('spaceMessageSearch').value = ''; this.renderSpace(); this.restoreDraft('space'); this.toggleChannels(false); setView('space');
      this.client?.requestHistory(id, this.activeChannel); this.client?.connect(space.owner).catch(() => {}); this.signatures.spaces = ''; this.renderSpaces(); this.markActiveRead();
    }
    renderSpace() {
      const space = this.store.state.spaces[this.activeSpace];
      if (!space) { if (this.currentView() === 'space') setView('spaces'); return; }
      if (!space.channels.some(channel => channel.id === this.activeChannel && channel.type === 'text')) this.activeChannel = space.channels.find(channel => channel.type === 'text')?.id;
      const channel = space.channels.find(item => item.id === this.activeChannel);
      const owner = this.client?.canManage(space.id); $('spaceName').textContent = space.name; $('spaceTopic').textContent = space.topic;
      $('spaceChannelName').textContent = channel?.name || 'geral'; $('spaceChannelTopic').textContent = channel?.topic || 'A conversa começa aqui.';
      $('spaceSettingsBtn').hidden = !owner; $('channelSettingsBtn').hidden = !owner; document.querySelectorAll('.manage-channel').forEach(button => { button.hidden = !owner; });
      $('leaveSpaceBtn').hidden = !!owner;
      const online = this.client?.roomOnline(space.id); $('spaceHostStatus').textContent = owner ? 'Você é o anfitrião deste espaço.' : online ? 'Anfitrião conectado' : 'Anfitrião offline'; $('spaceHostStatus').dataset.online = String(!!online);
      $('spaceConnectionNote').hidden = !!online; $('spaceConnectionNote').textContent = 'O anfitrião está offline. As mensagens ficam na fila e serão sincronizadas quando ele voltar.';
      const voice = this.client?.voice; const connectedHere = voice?.kind === 'space' && voice.space === space.id;
      $('channelVoiceBanner').hidden = !connectedHere;
      $('channelVoiceText').textContent = connectedHere ? 'Na voz · ' + (space.channels.find(item => item.id === voice.channel)?.name || 'Canal de voz') : '';
      this.renderChannels(space); this.renderMembers(space); this.renderChat('space');
    }
    renderChannels(space) {
      const roster = this.client?.roomRoster(space.id) || [];
      const signature = [space.id, space.revision, this.activeChannel, this.client?.voice?.channel, roster.map(member => [member.id, member.voice, member.muted, member.sharing].join(':')).join('|'), space.channels.map(channel => this.store.unread('space:' + space.id + ':' + channel.id, this.me())).join(':')].join('/');
      if (signature === this.signatures.channels) return; this.signatures.channels = signature;
      $('textChannels').replaceChildren(); $('voiceChannels').replaceChildren();
      for (const channel of space.channels) {
        const row = make('button', 'channel-item' + (channel.type === 'text' && this.activeChannel === channel.id ? ' active' : '') + (this.client?.voice?.space === space.id && this.client.voice.channel === channel.id ? ' in-voice' : ''));
        row.append(icon(channel.type === 'text' ? 'hash' : 'volume'), make('span', '', channel.name));
        row.setAttribute('aria-label', (channel.type === 'text' ? 'Canal de texto ' : 'Entrar no canal de voz ') + channel.name);
        if (channel.type === 'text') { const count = this.store.unread('space:' + space.id + ':' + channel.id, this.me()); if (count) row.append(make('span', 'channel-unread', count > 99 ? '99+' : String(count))); row.addEventListener('click', () => this.openSpace(space.id, channel.id)); $('textChannels').append(row); }
        else {
          row.addEventListener('click', () => this.joinVoice(space.id, channel.id)); $('voiceChannels').append(row);
          const members = make('div', 'voice-channel-members');
          for (const member of roster.filter(person => person.voice === channel.id)) { const entry = make('div', 'voice-channel-member'); entry.append(avatar(member), make('span', '', member.name)); if (member.sharing) entry.append(icon('screen')); else if (member.muted) entry.append(icon('mic')); entry.dataset.muted = String(member.muted); members.append(entry); }
          $('voiceChannels').append(members);
        }
      }
    }
    renderMembers(space) {
      const roster = new Map((this.client?.roomRoster(space.id) || []).map(person => [person.id, person]));
      const signature = space.id + space.revision + [...roster.values()].map(person => person.id + person.voice).join(':') + this.me();
      if (signature === this.signatures.members) return; this.signatures.members = signature;
      const list = $('spaceMembersList'); list.replaceChildren();
      const members = Object.entries(space.members).sort(([a], [b]) => Number(roster.has(b)) - Number(roster.has(a)) || space.members[a].name.localeCompare(space.members[b].name, 'pt-BR'));
      for (const [id, person] of members) { const entry = make('button', 'member-row'); entry.append(avatar(person)); const content = make('span', 'member-copy'); content.append(make('b', '', person.name + (id === this.me() ? ' (você)' : '')), make('span', '', id === space.owner ? 'Anfitrião' : roster.has(id) ? 'Por aqui' : 'Offline')); entry.append(content); entry.setAttribute('aria-label', id === this.me() ? 'Seu perfil' : 'Abrir contato de ' + person.name); entry.addEventListener('click', () => id === this.me() ? openProfile() : this.openDM(id)); list.append(entry); }
    }
    richText(element, value) {
      for (const part of String(value).split(/(https?:\/\/[^\s<>()]+)/g)) {
        if (/^https?:\/\//.test(part)) { try { const url = new URL(part); if (['https:', 'http:'].includes(url.protocol)) { const link = make('a', '', part); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; element.append(link); continue; } } catch (_) {} }
        element.append(document.createTextNode(part));
      }
    }
    renderChat(scope) {
      const key = this.threadKey(scope); if (!key) return;
      const search = $(scope + 'MessageSearch').value.toLocaleLowerCase('pt-BR'); let messages = this.store.messages(key);
      if (search) messages = messages.filter(message => (message.text + ' ' + message.name).toLocaleLowerCase('pt-BR').includes(search));
      if (this.bookmarkFilters[scope]) messages = messages.filter(message => this.store.state.bookmarks.includes(message.id));
      if (scope === 'space' && this.pinFilter) messages = messages.filter(message => message.pinned && !message.deleted);
      const limit = this.limits[key] || 100; const visible = messages.slice(-limit);
      const signature = key + search + !!this.bookmarkFilters[scope] + this.pinFilter + limit + visible.map(message => [message.id, message.revision, message.status, message.pinned, this.store.state.bookmarks.includes(message.id)].join(':')).join('|');
      if (signature === this.messageSignatures[scope]) return; this.messageSignatures[scope] = signature;
      const list = $(scope + 'Messages'); const same = list.dataset.key === key; const bottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90; const previousHeight = list.scrollHeight; const previousScroll = list.scrollTop; list.dataset.key = key; list.replaceChildren();
      if (messages.length > limit || (scope === 'space' && messages.length >= 50 && !search && !this.pinFilter)) list.append(button('Carregar mensagens anteriores', null, () => this.loadOlder(scope), 'text-button load-older'));
      if (!visible.length) {
        list.append(this.empty(search ? 'Nenhuma mensagem encontrada.' : this.bookmarkFilters[scope] || (scope === 'space' && this.pinFilter) ? 'As mensagens importantes ficam aqui.' : scope === 'dm' ? 'Dê o primeiro oi.' : 'Este canal é de vocês.', search ? 'Tente outra palavra.' : 'A conversa começa com a primeira mensagem.', scope === 'dm' ? 'chat' : 'hash'));
      }
      let day = '';
      for (const message of visible) {
        const nextDay = new Date(message.createdAt).toLocaleDateString('pt-BR'); if (day !== nextDay) { day = nextDay; list.append(make('div', 'message-date', date(message.createdAt))); }
        const item = make('article', 'chat-message' + (message.author === this.me() ? ' own-message' : '') + (message.deleted ? ' deleted-message' : '')); item.id = 'message-' + message.id;
        item.append(avatar(message, 'message-avatar')); const body = make('div', 'message-body');
        const meta = make('div', 'message-meta'); const timestamp = make('time', '', time(message.createdAt)); timestamp.dateTime = new Date(message.createdAt).toISOString(); timestamp.title = new Date(message.createdAt).toLocaleString('pt-BR'); meta.append(make('b', '', message.name || 'Visitante'), timestamp); if (message.editedAt && !message.deleted) meta.append(make('span', 'message-edited', 'editada')); if (message.pinned) { const pin = make('span', 'message-pin-label', 'Fixada'); pin.prepend(icon('pin')); meta.append(pin); } body.append(meta);
        if (message.replyTo) { const prior = this.store.messages(key).find(value => value.id === message.replyTo); const quote = make('button', 'message-quote', (prior?.name || 'Mensagem') + ': ' + (prior?.deleted ? 'Mensagem removida' : prior?.text.slice(0, 130) || 'Mensagem anterior')); quote.addEventListener('click', () => { const target = $('message-' + message.replyTo); if (target) { target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); target.classList.add('message-highlight'); setTimeout(() => target.classList.remove('message-highlight'), 1200); } }); body.append(quote); }
        const content = make('p', 'message-text'); if (message.deleted) content.textContent = 'Mensagem removida'; else this.richText(content, message.text); body.append(content);
        if (message.invite && !message.deleted && M.parseInvite(message.invite)) { const invite = make('div', 'message-invite'); invite.append(icon('spaces'), make('span', '', 'Um espaço para vocês.')); invite.append(button('Abrir convite', 'arrow', () => this.openJoinDialog(message.invite), 'secondary')); body.append(invite); }
        if (message.author === this.me()) { const receipt = make('span', 'message-receipt', message.status === 'queued' ? 'Na fila' : message.status === 'failed' ? 'Não entregue' : message.status === 'read' ? 'Lida' : 'Entregue'); receipt.dataset.status = message.status; if (message.status === 'read' || message.status === 'delivered') receipt.prepend(icon(message.status === 'read' ? 'checks' : 'check')); body.append(receipt); }
        item.append(body);
        if (!message.deleted) {
          const actions = make('div', 'message-actions'); actions.append(button('Responder à mensagem', 'reply', () => this.replyTo(scope, message.id)), button(this.store.state.bookmarks.includes(message.id) ? 'Remover dos salvos' : 'Salvar mensagem', 'star', () => this.store.bookmark(message.id)));
          if (scope === 'space' && this.client?.canManage(this.activeSpace)) actions.append(button(message.pinned ? 'Desafixar mensagem' : 'Fixar mensagem', 'pin', () => { try { this.client.pin(this.activeSpace, this.activeChannel, message.id); } catch (error) { statusMsg(error.message); } }));
          if (message.author === this.me()) actions.append(button('Editar mensagem', 'edit', () => this.openMessageEdit(scope, message.id)), button('Remover mensagem', 'trash', () => this.deleteMessage(scope, message.id)));
          item.append(actions);
        }
        list.append(item);
      }
      if (!same || bottom || this.justSent === key) { list.scrollTop = list.scrollHeight; this.justSent = null; }
      else if (this.loadingOlder === key) { list.scrollTop = previousScroll + list.scrollHeight - previousHeight; this.loadingOlder = null; }
      else list.scrollTop = previousScroll;
      $(scope === 'dm' ? 'dmBookmarkFilter' : 'spacePinFilter').classList.toggle('active', scope === 'dm' ? !!this.bookmarkFilters.dm : this.pinFilter);
    }
    loadOlder(scope) {
      const key = this.threadKey(scope); if (!key) return; this.loadingOlder = key; this.limits[key] = (this.limits[key] || 100) + 100;
      if (scope === 'space') this.client?.requestHistory(this.activeSpace, this.activeChannel, this.store.messages(key)[0]?.createdAt || 0);
      this.renderChat(scope);
    }
    rememberDraft(scope) { const key = this.threadKey(scope); if (key) this.drafts.set(key, $(scope + 'Composer').value); }
    restoreDraft(scope) { const key = this.threadKey(scope); $(scope + 'Composer').value = this.drafts.get(key) || ''; this.composerSize(scope); this.cancelReply(scope); }
    composerSize(scope) { const input = $(scope + 'Composer'); input.style.height = 'auto'; if (input.getClientRects().length) input.style.height = Math.max(44, Math.min(input.scrollHeight, 150)) + 'px'; $(scope + 'CharacterCount').textContent = input.value.length > 3500 ? input.value.length + '/4000' : ''; }
    composerInput(scope) { this.rememberDraft(scope); this.composerSize(scope); if (scope === 'dm' && this.activeDM) this.client?.sendTyping('dm', this.activeDM); else if (scope === 'space') this.client?.sendTyping('space', this.activeSpace, this.activeChannel); }
    composerKey(event, scope) { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.sendMessage(scope); } }
    sendMessage(scope) {
      if (!this.ready()) return;
      try {
        const input = $(scope + 'Composer'); const value = input.value.trim(); if (!value) return; const key = this.threadKey(scope);
        if (scope === 'dm') this.client.sendDM(this.activeDM, value, this.reply[scope]?.id);
        else this.client.sendSpaceMessage(this.activeSpace, this.activeChannel, value, this.reply[scope]?.id);
        this.justSent = key; input.value = ''; this.drafts.delete(key); this.cancelReply(scope); this.composerSize(scope); this.renderChat(scope); input.focus();
      } catch (error) { statusMsg(error.message); }
    }
    replyTo(scope, id) {
      const key = this.threadKey(scope); const message = this.store.messages(key).find(item => item.id === id); if (!message) return;
      this.reply[scope] = { key, id }; const bar = $(scope + 'Reply'); bar.hidden = false; bar.querySelector('span').textContent = 'Respondendo a ' + message.name + ' · ' + message.text.slice(0, 100); $(scope + 'Composer').focus();
    }
    cancelReply(scope) { delete this.reply[scope]; $(scope + 'Reply').hidden = true; }
    toggleSearch(scope) { const bar = $(scope + 'SearchBar'); bar.hidden = !bar.hidden; if (!bar.hidden) $(scope + 'MessageSearch').focus(); else { $(scope + 'MessageSearch').value = ''; this.renderChat(scope); } }
    toggleBookmarks(scope) { this.bookmarkFilters[scope] = !this.bookmarkFilters[scope]; this.renderChat(scope); }
    togglePins() { this.pinFilter = !this.pinFilter; this.renderChat('space'); }
    toggleChannels(show) { $('spaceShell').classList.toggle('channels-open', show === undefined ? !$('spaceShell').classList.contains('channels-open') : show); }
    toggleMembers(show) { const visible = show === undefined ? $('spaceMembers').hidden : show; $('spaceMembers').hidden = !visible; $('spaceMembersToggle').setAttribute('aria-expanded', String(visible)); }
    markActiveRead() {
      if (!this.client || document.visibilityState === 'hidden' || !document.hasFocus()) return;
      const view = this.currentView(); const scope = view === 'dm' ? 'dm' : view === 'space' ? 'space' : null; const key = scope && this.threadKey(scope);
      if (!key || !this.store.unread(key, this.me())) return;
      if (scope === 'dm') this.client.readDM(this.activeDM);
      else this.store.markRead(key, Math.max(Date.now(), ...this.store.messages(key).map(message => message.createdAt)));
    }
  }
  window.NexusCommunity = Community;
  window.NexusUI = { $, make, icon, button, avatar, statusNames };
})();
