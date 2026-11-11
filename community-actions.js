(function () {
  'use strict';
  const M = NexusModel;
  const { $, make, icon, button } = NexusUI;
  Object.assign(NexusCommunity.prototype, {
    installHandlers() {
      document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); this.openQuickSearch(); } });
      $('quickSearchInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('quickSearchResults').querySelector('button')?.click(); } });
      window.addEventListener('focus', () => this.markActiveRead());
      document.addEventListener('visibilitychange', () => this.markActiveRead());
      window.addEventListener('beforeunload', () => { this.client?.destroy(); clearInterval(this.interval); if (peer && !peer.destroyed) peer.destroy(); });
      document.querySelectorAll('.social-dialog, .quick-search-dialog').forEach(dialog => dialog.addEventListener('cancel', event => { event.preventDefault(); this.closeDialog(dialog.id); }));
      $('friendsList').setAttribute('role', 'tabpanel');
      document.querySelectorAll('.friends-tabs [role="tab"]').forEach(tab => tab.setAttribute('aria-controls', 'friendsList'));
      const empty = $('roomEmpty');
      empty.querySelector('h2').textContent = 'A conversa ganha voz.';
      empty.querySelector('p').textContent = 'Ligue para um amigo ou entre na voz de um espaço. A tela também tem lugar na conversa.';
      const primary = empty.querySelector('.primary'); primary.replaceChildren(document.createTextNode('Ver meus amigos'), icon('arrow')); primary.onclick = () => setView('friends');
      const secondary = empty.querySelector('.text-button'); secondary.textContent = 'Entrar em um espaço'; secondary.onclick = () => setView('spaces');
    },
    showDialog(id, focusId) {
      const dialog = $(id); if (dialog.open) return;
      this.dialogTriggers.set(id, document.activeElement); dialog.classList.remove('is-closing'); dialog.showModal(); if (focusId) $(focusId).focus({ preventScroll: true });
    },
    closeDialog(id, immediate = false) {
      const dialog = $(id); if (!dialog?.open || dialog.classList.contains('is-closing')) return;
      const finish = () => { dialog.close(); dialog.classList.remove('is-closing'); const trigger = this.dialogTriggers.get(id); if (trigger?.isConnected && trigger.getClientRects().length && !trigger.closest('[inert]')) trigger.focus({ preventScroll: true }); };
      if (immediate || matchMedia('(prefers-reduced-motion: reduce)').matches) finish(); else { dialog.classList.add('is-closing'); setTimeout(finish, 170); }
    },
    confirm(title, description, action, label = 'Confirmar') {
      $('socialConfirmTitle').textContent = title; $('socialConfirmDescription').textContent = description; $('socialConfirmAction').textContent = label;
      $('socialConfirmAction').onclick = async () => { this.closeDialog('socialConfirmDialog', true); try { await action(); } catch (error) { statusMsg(error.message); } };
      this.showDialog('socialConfirmDialog', 'socialConfirmAction');
    },
    addFriend() {
      if (!this.ready()) return;
      try { const id = M.parseContact($('friendIdInput').value); if (!id) throw new Error('Cole o ID ou o link de contato da pessoa.'); this.client.requestFriend(id); $('friendIdInput').value = ''; this.setFriendsFilter('requests'); statusMsg('Solicitação enviada. Ela fica na fila se a pessoa estiver offline.'); }
      catch (error) { statusMsg(error.message); }
    },
    async copyContact() {
      if (!this.ready()) return;
      try { await navigator.clipboard.writeText(M.contactLink(location.href, this.me())); statusMsg('Seu link de contato foi copiado.'); }
      catch (_) { setView('settings'); setSettingsTab('privacy'); $('myContactId').focus(); $('myContactId').select(); statusMsg('Selecione e copie seu ID de contato.'); }
    },
    openContactMenu(id = this.activeDM) {
      const person = this.store.contact(id); if (!person) return; this.menuContact = id;
      $('contactMenuTitle').textContent = person.name; $('contactMenuId').textContent = id; this.showDialog('contactMenuDialog');
    },
    contactAction(action) {
      if (!this.ready()) return; const id = this.menuContact; const person = this.store.contact(id); if (!person) return;
      this.confirm(action === 'block' ? 'Bloquear ' + person.name + '?' : 'Remover ' + person.name + ' dos amigos?', action === 'block' ? 'Este contato não poderá enviar mensagens nem ligar. Seu histórico fica com você.' : 'Para conversar novamente, vocês precisarão aceitar uma nova solicitação.', () => { if (action === 'block') this.client.block(id); else this.client.removeFriend(id); this.closeDialog('contactMenuDialog', true); }, action === 'block' ? 'Bloquear' : 'Remover amizade');
    },
    saveSocialPreferences() { this.store.transaction(state => { state.preferences.requests = $('friendRequestsCheck').checked; }); },
    savePresence() { if (!this.client) return; this.store.transaction(state => { state.preferences.presence = ['online', 'away', 'busy'].includes($('profilePresence').value) ? $('profilePresence').value : 'online'; }); },
    exportHistory() {
      const payload = { exportedAt: new Date().toISOString(), profile: { id: this.me(), ...M.profile(profile) }, data: this.store.state };
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })); const link = make('a'); link.href = url; link.download = 'nexus-historico-' + new Date().toISOString().slice(0, 10) + '.json'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    openSpaceDialog(id = null) {
      if (!this.ready()) return; const space = id ? this.store.state.spaces[id] : null;
      if (space && !this.client.canManage(id)) { statusMsg('Só o anfitrião pode configurar este espaço.'); return; }
      this.editingSpace = space?.id || null; $('spaceDialogTitle').textContent = space ? 'O espaço de vocês.' : 'Um espaço de vocês.';
      $('spaceNameInput').value = space?.name || ''; $('spaceTopicInput').value = space?.topic || '';
      $('saveSpaceBtn').replaceChildren(document.createTextNode(space ? 'Salvar espaço' : 'Criar espaço'), icon('arrow')); $('closeSpaceBtn').hidden = !space;
      this.showDialog('spaceDialog', 'spaceNameInput');
    },
    saveSpace() {
      if (!this.ready()) return;
      try { const name = $('spaceNameInput').value.trim(); if (!name) { $('spaceNameInput').focus(); return; }
        const space = this.editingSpace ? this.client.configureSpace(this.editingSpace, { name, topic: $('spaceTopicInput').value }) : this.client.createSpace(name);
        if (!this.editingSpace && $('spaceTopicInput').value.trim()) this.client.configureSpace(space.id, { topic: $('spaceTopicInput').value });
        this.closeDialog('spaceDialog'); this.openSpace(space.id); statusMsg(this.editingSpace ? 'Espaço atualizado.' : 'Seu espaço está pronto. Agora é só chamar sua gente.');
      } catch (error) { statusMsg(error.message); }
    },
    closeCurrentSpace() {
      const id = this.editingSpace; const space = this.store.state.spaces[id]; if (!space) return;
      this.confirm('Encerrar ' + space.name + '?', 'Os participantes conectados sairão do espaço e os convites deixarão de funcionar. O histórico local fica preservado.', () => { this.client.closeSpace(id); this.closeDialog('spaceDialog', true); this.activeSpace = null; setView('spaces'); }, 'Encerrar espaço');
    },
    leaveCurrentSpace() {
      const space = this.store.state.spaces[this.activeSpace]; if (!space || !this.ready()) return;
      this.confirm('Sair de ' + space.name + '?', 'Você poderá voltar com um novo convite. Seu histórico local fica preservado.', () => { this.client.leaveSpace(space.id); this.activeSpace = null; setView('spaces'); }, 'Sair do espaço');
    },
    openJoinDialog(value = '') { if (!this.ready()) return; $('spaceInviteInput').value = value; this.showDialog('joinSpaceDialog', 'spaceInviteInput'); },
    async joinSpaceFromDialog() {
      if (!this.ready()) return; const button = $('joinSpaceBtn'); button.disabled = true; button.setAttribute('aria-busy', 'true');
      try { const id = await this.client.joinInvite($('spaceInviteInput').value); this.closeDialog('joinSpaceDialog'); this.openSpace(id); statusMsg('Pode chegar. Você entrou no espaço.'); }
      catch (error) { statusMsg(error.message); }
      finally { button.disabled = false; button.removeAttribute('aria-busy'); }
    },
    async submitHome() {
      if (!this.ready()) return;
      if (entryMode === 'create') { this.openSpaceDialog(); return; }
      const value = $('roomId').value.trim(); if (!M.parseInvite(value)) { this.openJoinDialog(value); return; }
      const button = $('enterRoomBtn'); button.disabled = true;
      try { const id = await this.client.joinInvite(value); this.openSpace(id); } catch (error) { statusMsg(error.message); } finally { button.disabled = false; }
    },
    openChannelDialog(type = 'text', id = null) {
      if (!this.ready() || !this.client.canManage(this.activeSpace)) return;
      const channel = this.store.state.spaces[this.activeSpace]?.channels.find(item => item.id === id); this.editingChannel = channel?.id || null;
      $('channelDialogTitle').textContent = channel ? 'O canal de vocês.' : 'Um novo canal.'; $('channelNameInput').value = channel?.name || ''; $('channelTypeInput').value = channel?.type || type; $('channelTypeInput').disabled = !!channel; $('channelTopicInput').value = channel?.topic || ''; $('deleteChannelBtn').hidden = !channel;
      this.showDialog('channelDialog', 'channelNameInput');
    },
    saveChannel() {
      if (!this.ready()) return;
      try { const name = $('channelNameInput').value.trim(); if (!name) return;
        if (this.editingChannel) this.client.configureChannel(this.activeSpace, this.editingChannel, { name, topic: $('channelTopicInput').value });
        else { const channel = this.client.addChannel(this.activeSpace, name, $('channelTypeInput').value); if (channel.type === 'text') this.activeChannel = channel.id; if ($('channelTopicInput').value.trim()) this.client.configureChannel(this.activeSpace, channel.id, { name, topic: $('channelTopicInput').value }); }
        this.closeDialog('channelDialog'); this.renderSpace(); statusMsg('Canal salvo.');
      } catch (error) { statusMsg(error.message); }
    },
    deleteChannel() {
      const space = this.store.state.spaces[this.activeSpace]; const channel = space?.channels.find(item => item.id === this.editingChannel); if (!channel) return;
      this.confirm('Excluir o canal ' + channel.name + '?', 'O canal deixa de aparecer para os participantes. As mensagens já recebidas ficam no histórico local.', () => { this.client.configureChannel(space.id, channel.id, { remove: true }); this.closeDialog('channelDialog', true); this.renderSpace(); }, 'Excluir canal');
    },
    openInviteDialog() {
      if (!this.ready()) return; const space = this.store.state.spaces[this.activeSpace]; if (!space) return;
      $('inviteSpaceName').textContent = space.name; $('spaceInviteLink').value = M.inviteLink(location.href, space); $('inviteRenewControls').hidden = !this.client.canManage(space.id);
      $('inviteExpiryHint').textContent = space.invite.expiresAt ? 'Válido até ' + new Date(space.invite.expiresAt).toLocaleString('pt-BR') : 'Qualquer pessoa com este convite pode entrar.';
      const select = $('inviteFriendSelect'); select.replaceChildren(); const placeholder = make('option', '', 'Escolha um amigo'); placeholder.value = ''; select.append(placeholder);
      for (const friend of Object.values(this.store.state.contacts).filter(person => person.state === 'accepted')) { const option = make('option', '', friend.name); option.value = friend.id; select.append(option); }
      this.showDialog('inviteDialog');
    },
    async copySpaceInvite() { try { await navigator.clipboard.writeText($('spaceInviteLink').value); statusMsg('Convite copiado.'); } catch (_) { $('spaceInviteLink').focus(); $('spaceInviteLink').select(); statusMsg('Selecione e copie o convite.'); } },
    renewInvite() { if (!this.ready()) return; try { this.client.renewInvite(this.activeSpace, Number($('inviteValidity').value)); const room = this.store.state.spaces[this.activeSpace]; $('spaceInviteLink').value = M.inviteLink(location.href, room); $('inviteExpiryHint').textContent = room.invite.expiresAt ? 'Válido até ' + new Date(room.invite.expiresAt).toLocaleString('pt-BR') : 'Convite sem prazo. O link anterior foi desativado.'; statusMsg('Novo convite criado.'); } catch (error) { statusMsg(error.message); } },
    inviteFriend() {
      if (!this.ready()) return;
      try { const id = $('inviteFriendSelect').value; const space = this.store.state.spaces[this.activeSpace]; if (!id || !space) return; this.client.sendDM(id, 'Vem para o espaço ' + space.name + '.', null, M.inviteLink(location.href, space)); statusMsg('Convite enviado por mensagem direta.'); }
      catch (error) { statusMsg(error.message); }
    },
    openMessageEdit(scope, id) {
      const key = this.threadKey(scope); const message = this.store.messages(key).find(item => item.id === id); if (!message || message.author !== this.me()) return;
      this.editingMessage = { key, id }; $('messageEditInput').value = message.text; this.showDialog('messageEditDialog', 'messageEditInput');
    },
    saveMessageEdit() { if (!this.ready() || !this.editingMessage) return; try { this.client.editMessage(this.editingMessage.key, this.editingMessage.id, $('messageEditInput').value); this.closeDialog('messageEditDialog'); } catch (error) { statusMsg(error.message); } },
    deleteMessage(scope, id) { const key = this.threadKey(scope); this.confirm('Remover esta mensagem?', 'A mensagem será removida para os participantes desta conversa.', () => this.client.editMessage(key, id, '', true), 'Remover mensagem'); },
    openQuickSearch() { $('quickSearchInput').value = ''; this.renderQuickSearch(); this.showDialog('quickSearchDialog', 'quickSearchInput'); },
    renderQuickSearch() {
      const query = $('quickSearchInput').value.trim().toLocaleLowerCase('pt-BR'); const results = $('quickSearchResults'); results.replaceChildren();
      const add = (label, description, symbol, action) => { const row = make('button', 'quick-result'); row.append(icon(symbol)); const copy = make('span'); copy.append(make('b', '', label), make('span', '', description)); row.append(copy, icon('chevron')); row.addEventListener('click', () => { this.closeDialog('quickSearchDialog', true); action(); }); results.append(row); };
      for (const friend of Object.values(this.store.state.contacts).filter(person => person.state === 'accepted' && (!query || person.name.toLocaleLowerCase('pt-BR').includes(query))).slice(0, 6)) add(friend.name, 'Mensagem direta', 'user', () => this.openDM(friend.id));
      for (const space of Object.values(this.store.state.spaces).filter(room => !query || room.name.toLocaleLowerCase('pt-BR').includes(query)).slice(0, 6)) add(space.name, 'Espaço · ' + space.channels.length + ' canais', 'spaces', () => this.openSpace(space.id));
      if (query.length > 1) for (const [key, messages] of Object.entries(this.store.state.threads)) {
        if (results.children.length >= 18) break;
        const parts = key.split(':'); const room = parts[0] === 'space' ? this.store.state.spaces[parts[1]] : null; const contact = parts[0] === 'dm' ? this.store.contact(parts[1]) : null;
        if (!room && !contact) continue;
        for (const message of messages.filter(value => !value.deleted && value.text.toLocaleLowerCase('pt-BR').includes(query)).slice(-3)) {
          if (results.children.length >= 18) break;
          add(message.text.slice(0, 90), room ? room.name + ' · ' + (room.channels.find(channel => channel.id === parts[2])?.name || 'canal') : contact.name, 'chat', () => {
            this.limits[key] = messages.length; if (room) this.openSpace(room.id, parts[2]); else this.openDM(contact.id); this.pendingHighlight = message.id;
          });
        }
      }
      if (!results.children.length) results.append(make('p', 'quick-empty', query ? 'Nada por aqui com essa busca.' : 'Seus amigos, espaços e mensagens aparecem aqui.'));
    },
    handleEvent(event) {
      this.scheduleRender();
      if (['space-state', 'online', 'voice-roster'].includes(event.type)) this.reconcileVoice();
      if (event.type === 'message') {
        const active = event.scope === 'dm' ? this.currentView() === 'dm' && this.activeDM === event.peer : this.currentView() === 'space' && this.activeSpace === event.space && this.activeChannel === event.channel;
        if (active) { this.markActiveRead(); $('socialAnnouncer').textContent = event.message.name + ': ' + (event.message.deleted ? 'Mensagem removida' : event.message.text.slice(0, 160)); }
        else if (event.message.author !== this.me() && event.message.revision === 0 && this.store.state.preferences.presence !== 'busy') statusMsg(event.message.name + ': ' + (event.message.invite ? 'Convite para um espaço' : event.message.text.slice(0, 100)));
      }
      if (event.type === 'online' && this.activeDM === event.peer && this.currentView() === 'dm') this.client.readDM(event.peer);
      if (event.type === 'history') this.markActiveRead();
      if (event.type === 'notice') statusMsg(event.message);
      if (event.type === 'friend-request') statusMsg('Você recebeu uma solicitação de ' + (this.store.contact(event.peer)?.name || 'amizade') + '.');
      if (event.type === 'friend-accepted') statusMsg((this.store.contact(event.peer)?.name || 'Seu contato') + ' agora faz parte da sua gente.');
      if (event.type === 'typing') {
        const scope = event.scope; const matches = scope === 'dm' ? event.peer === this.activeDM : event.space === this.activeSpace && event.channel === this.activeChannel;
        if (matches) { const target = $(scope + 'Typing'); target.textContent = event.name + ' está digitando...'; clearTimeout(this.typingTimers.get(scope)); this.typingTimers.set(scope, setTimeout(() => { target.textContent = ''; }, 3500)); }
      }
      if (event.type === 'incoming-call') this.showIncomingCall(event.call);
      if (event.type === 'call-accepted') { $('ringOverlay').close(); this.reconcileVoice(); }
      if (event.type === 'call-ended') { $('ringOverlay').close(); this.stopMedia(); if (['busy', 'declined', 'unanswered', 'disconnected'].includes(event.reason)) statusMsg({ busy: 'Esta pessoa não pode atender agora.', declined: 'A ligação foi recusada.', unanswered: 'Ninguém atendeu. Tente novamente mais tarde.', disconnected: 'A ligação foi encerrada por perda de conexão.' }[event.reason]); if (this.currentView() === 'room' && event.call?.peer) this.openDM(event.call.peer); }
      if (event.type === 'voice-left') { this.stopMedia(); if (this.currentView() === 'room') { if (event.previous.kind === 'space' && this.store.state.spaces[event.previous.space]) this.openSpace(event.previous.space); else if (event.previous.peer) this.openDM(event.previous.peer); } }
      if (event.type === 'voice-rejected') statusMsg(event.message);
      if (event.type === 'media-state') { const person = participants.get(event.peer); if (person) { person.sharing = event.sharing; person.muted = event.muted; setTileSharing(event.peer, event.sharing); updateSpotlight(); } }
      if (event.type === 'space-closed' && this.activeSpace === event.space) { this.activeSpace = null; setView('spaces'); statusMsg('O anfitrião encerrou este espaço.'); }
    },
    showIncomingCall(call) {
      const person = this.store.contact(call.peer); $('ringTitle').textContent = (person?.name || 'Seu amigo') + ' quer conversar.';
      $('ringOverlay').querySelector('.ring-card > p').textContent = 'Uma ligação privada, só entre vocês.';
      const circle = $('ringOverlay').querySelector('.avatar-circle'); renderAvatar(circle, person?.avatar, person?.name);
      if (!$('ringOverlay').open) $('ringOverlay').showModal();
    },
    async prepareMedia() {
      await getLocalStream(); inRoom = true; ensureTile('local', { name: profile.name, avatar: profile.avatar, isLocal: true }); tiles.get('local').video.srcObject = localStream; updateParticipantCount(); syncRoomUI();
    },
    stopMedia() {
      this.voiceRevision++;
      if (localStream || inRoom || rawMicStream) leaveRoom({ internal: true, quiet: true });
      document.body.classList.remove('has-voice'); this.renderVoiceDock();
    },
    async startDMCall(id = this.activeDM, switching = false) {
      if (!this.ready() || !id || this.preparingVoice) return;
      if (!switching && (inRoom || this.client.voice || this.client.outgoingCall)) { this.confirm('Trocar de chamada?', 'A chamada atual será encerrada para ligar para este amigo.', async () => { this.leaveVoice(); await this.startDMCall(id, true); }, 'Trocar de chamada'); return; }
      this.preparingVoice = true;
      try {
        if (!await this.client.connect(id, true)) throw new Error('Esta pessoa está offline. Tente novamente quando ela voltar.');
        await this.prepareMedia(); await this.client.startCall(id); updateConnBadge('', 'Chamando...'); setView('room'); this.renderVoiceDock();
      } catch (error) { this.stopMedia(); statusMsg(error.message); }
      finally { this.preparingVoice = false; }
    },
    async acceptDMCall() {
      if (!this.client?.pendingCall) return; const accept = $('acceptBtn'); accept.disabled = true;
      try { await this.prepareMedia(); if (!this.client.acceptCall()) { this.stopMedia(); return; } $('ringOverlay').close(); setView('room'); this.renderVoiceDock(); }
      catch (error) { this.client.endCall('declined'); this.stopMedia(); statusMsg(error.message); }
      finally { accept.disabled = false; }
    },
    async joinVoice(spaceId, channel, switching = false) {
      if (!this.ready() || this.preparingVoice) return;
      if (this.client.voice?.space === spaceId && this.client.voice.channel === channel) { setView('room'); return; }
      if (!switching && (inRoom || this.client.voice || this.client.outgoingCall)) { this.confirm('Mudar de canal de voz?', 'Você sairá da chamada atual para entrar neste canal.', async () => { this.leaveVoice(); await this.joinVoice(spaceId, channel, true); }, 'Entrar no canal'); return; }
      if (!this.client.roomOnline(spaceId)) { statusMsg('O anfitrião precisa estar conectado para abrir este canal de voz.'); return; }
      this.preparingVoice = true;
      try { await this.prepareMedia(); this.client.joinVoice(spaceId, channel); updateConnBadge('', 'Aguardando companhia'); this.renderVoiceDock(); this.renderSpace(); this.reconcileVoice(); }
      catch (error) { this.stopMedia(); statusMsg(error.message); }
      finally { this.preparingVoice = false; }
    },
    leaveVoice() {
      if (!this.client) { this.stopMedia(); return; }
      const context = this.client.voice; const call = this.client.outgoingCall || this.client.pendingCall;
      if (context) this.client.leaveVoice(); else if (call) this.client.endCall('ended');
      this.stopMedia();
      if (this.currentView() === 'room') { if (context?.kind === 'space') this.openSpace(context.space); else if (context?.peer || call?.peer) this.openDM(context?.peer || call.peer); else setView('home'); }
    },
    async reconcileVoice() {
      if (!this.client?.voice || !inRoom || !localStream) return;
      const context = this.client.voice; const revision = this.voiceRevision; const targets = this.client.voiceTargets();
      for (const [id, person] of [...participants]) if (!targets.includes(id)) { person.call?.close(); removeParticipant(id); }
      for (const id of targets) {
        const member = this.client.voiceMember(id) || { name: 'Participante', avatar: 'carbon' };
        if (!participants.has(id)) wireParticipant(id, null, null);
        const person = participants.get(id); person.name = member.name; person.avatar = member.avatar; person.sharing = !!member.sharing;
        updateTileLabel(id, member.name, member.avatar); setTileSharing(id, !!member.sharing); const tile = tiles.get(id); if (tile) { tile.wrap.dataset.muted = String(!!member.muted); tile.label.textContent = member.muted ? 'Microfone desativado' : 'Em boa companhia'; }
        if (!this.client.initiatesMedia(id) || person.call || person.connecting) continue;
        person.connecting = true;
        try {
          const connected = await this.client.connect(id);
          if (!connected || !inRoom || this.voiceRevision !== revision || this.client.voice?.session !== context.session || participants.get(id) !== person) continue;
          const call = peer.call(id, localStream, { metadata: { nexusVoice: 1, session: context.session } }); person.call = call; wireCall(id, call);
        } catch (_) { statusMsg('Não foi possível conectar a voz de um participante.'); }
        finally { person.connecting = false; }
      }
      updateParticipantCount(); updateSpotlight(); this.renderVoiceDock();
    },
    async receiveMedia(incoming) {
      if (!this.client || !inRoom || !localStream) { incoming.close(); return; }
      if (!this.client.mediaAllowed(incoming.peer, incoming.metadata)) await new Promise(resolve => setTimeout(resolve, 350));
      if (!inRoom || !localStream || !this.client.mediaAllowed(incoming.peer, incoming.metadata) || this.client.initiatesMedia(incoming.peer)) { incoming.close(); return; }
      const member = this.client.voiceMember(incoming.peer); wireParticipant(incoming.peer, null, null); const person = participants.get(incoming.peer);
      if (person.call && person.call !== incoming) person.call.close(); person.call = incoming; person.name = member?.name || 'Participante'; person.avatar = member?.avatar || 'carbon';
      updateTileLabel(incoming.peer, person.name, person.avatar); incoming.answer(localStream); wireCall(incoming.peer, incoming); updateParticipantCount();
    },
    publishVoiceState() { this.client?.voiceState({ muted: !micOn, deafened, sharing: mySharing }); this.renderVoiceDock(); },
    updateCallInvite() {
      const context = this.client?.voice; const room = context?.kind === 'space' ? this.store.state.spaces[context.space] : null;
      $('inviteBox').style.display = room ? 'block' : 'none'; document.querySelector('.room-invite').hidden = !room;
      $('inviteLink').value = room ? M.inviteLink(location.href, room) : '';
    },
    renderVoiceDock() {
      const voice = this.client?.voice; const outgoing = this.client?.outgoingCall; const active = inRoom && !!(voice || outgoing);
      $('voiceDock').hidden = !active; document.body.classList.toggle('has-voice', active);
      if (!active) return;
      const space = voice?.kind === 'space' ? this.store.state.spaces[voice.space] : null;
      const title = space ? space.channels.find(channel => channel.id === voice.channel)?.name || 'Canal de voz' : this.store.contact(voice?.peer || outgoing?.peer)?.name || 'Chamada privada';
      const elapsed = Math.max(0, Math.floor((Date.now() - (voice?.startedAt || outgoing?.createdAt || Date.now())) / 1000)); const duration = String(Math.floor(elapsed / 60)).padStart(2, '0') + ':' + String(elapsed % 60).padStart(2, '0');
      $('voiceDockTitle').textContent = title; $('voiceDockSubtitle').textContent = outgoing ? 'Chamando...' : duration + (space ? ' · ' + space.name : ' · Ligação privada');
      $('dockMicBtn').classList.toggle('off', !micOn); $('dockMicBtn').setAttribute('aria-label', micOn ? 'Desativar microfone' : 'Ativar microfone');
      $('roomHeading').replaceChildren(document.createTextNode(title), make('span', 'quiet-dot', '.'));
      if (outgoing) updateConnBadge('', 'Chamando...');
      this.updateCallInvite();
    }
  });
  const originalOnView = NexusCommunity.prototype.onView;
  NexusCommunity.prototype.onView = function (view) {
    originalOnView.call(this, view);
    if (this.pendingHighlight) { const target = $('message-' + this.pendingHighlight); this.pendingHighlight = null; if (target) { target.scrollIntoView({ block: 'center' }); target.classList.add('message-highlight'); setTimeout(() => target.classList.remove('message-highlight'), 1400); } }
  };
  window.community = new NexusCommunity();
  community.boot();
})();
