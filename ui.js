/* Interface state stays separate from the WebRTC/audio implementation. */
let entryMode = 'create';
let enteringRoom = false;
let draftAvatar = profile.avatar;
let profileTrigger = null;

function setEntryMode(mode) {
  const changed = entryMode !== (mode === 'join' ? 'join' : 'create');
  entryMode = mode === 'join' ? 'join' : 'create';
  const joining = entryMode === 'join';
  document.getElementById('joinField').hidden = !joining;
  document.getElementById('roomId').required = joining;
  document.getElementById('roomId').setCustomValidity('');
  document.getElementById('entryEyebrow').textContent = joining ? 'TEM LUGAR PRA VOCÊ' : 'A CONVERSA É SUA';
  document.getElementById('entryTitle').replaceChildren();
  const title = document.getElementById('entryTitle');
  title.append(document.createTextNode(joining ? 'A sua gente' : 'Abre a sala.'), document.createElement('br'), document.createTextNode(joining ? 'está te esperando.' : 'Chama a sua gente.'));
  document.getElementById('entryDescription').textContent = joining ? 'Cole o convite e chegue mais. O papo já vai começar.' : 'Um espaço só de vocês, a um clique de distância.';
  document.getElementById('entryButtonLabel').textContent = joining ? 'Entrar na sala' : 'Criar uma sala';
  document.getElementById('entryForm').setAttribute('aria-labelledby', joining ? 'tab-join' : 'tab-create');
  document.querySelectorAll('.entry-tab').forEach(tab => {
    const selected = tab.id === 'tab-' + entryMode;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  if (changed) animateContent(document.querySelector('.entry-heading'));
}

function roomIdFromInput(value) {
  const input = String(value || '').trim();
  let roomId = input;
  if (/^https?:\/\//i.test(input)) {
    try { roomId = new URL(input).searchParams.get('room') || ''; }
    catch (_) { return ''; }
  }
  return /^[a-zA-Z0-9_-]{1,128}$/.test(roomId) ? roomId : '';
}

async function submitRoom() {
  if (enteringRoom) return;
  if (inRoom) { setView('room'); return; }
  const input = document.getElementById('roomId');
  if (entryMode === 'join') {
    const id = roomIdFromInput(input.value);
    if (!id) {
      input.setCustomValidity('Cole um ID válido ou um link de convite que contenha o ID da sala.');
      input.reportValidity();
      input.focus();
      return;
    }
    input.value = id;
  } else input.value = '';
  enteringRoom = true;
  const button = document.getElementById('enterRoomBtn');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  document.getElementById('entryButtonLabel').textContent = 'Preparando seu espaço…';
  try { await enterRoom(); }
  catch (_) { statusMsg('Não foi possível abrir a sala. Tente novamente.'); }
  finally {
    enteringRoom = false;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    document.getElementById('entryButtonLabel').textContent = entryMode === 'join' ? 'Entrar na sala' : 'Criar uma sala';
    syncRoomUI();
  }
}

function syncRoomUI() {
  document.getElementById('roomEmpty').hidden = inRoom;
  document.getElementById('roomStage').hidden = !inRoom;
  document.getElementById('roomIndicator').hidden = !inRoom;
  document.getElementById('sessionNotice').hidden = !inRoom;
  document.getElementById('entryForm').hidden = inRoom;
  document.querySelector('.entry-tabs').hidden = inRoom;
  document.querySelector('.entry-footnote').hidden = inRoom;
  syncCallControls();
}

function syncCallControls() {
  const mic = document.getElementById('micBtn');
  mic.setAttribute('aria-pressed', String(!micOn));
  mic.setAttribute('aria-label', micOn ? 'Desativar microfone' : 'Ativar microfone');
  mic.title = (micOn ? 'Desativar' : 'Ativar') + ' microfone (M)';
  const deafen = document.getElementById('deafenBtn');
  deafen.setAttribute('aria-pressed', String(deafened));
  deafen.setAttribute('aria-label', deafened ? 'Voltar a ouvir a chamada' : 'Silenciar áudio recebido');
  deafen.title = deafen.getAttribute('aria-label');
  const share = document.getElementById('shareBtn');
  share.setAttribute('aria-pressed', String(mySharing));
  share.setAttribute('aria-label', mySharing ? 'Parar compartilhamento' : 'Compartilhar tela');
  share.title = share.getAttribute('aria-label');
}

function openProfile() {
  const dialog = document.getElementById('profileDialog');
  if (dialog.open) return;
  profileTrigger = document.activeElement;
  draftAvatar = normalizeAvatar(profile.avatar);
  const input = document.getElementById('profileName');
  input.value = profile.name;
  input.setCustomValidity('');
  renderProfileOptions();
  updateProfilePreview();
  dialog.showModal();
  input.focus({ preventScroll: true });
}

function renderProfileOptions() {
  const grid = document.getElementById('avatarOptions');
  grid.replaceChildren();
  AVATAR_CATALOG.forEach(choice => {
    const label = document.createElement('label');
    label.className = 'avatar-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'avatar';
    radio.value = choice.id;
    radio.checked = draftAvatar === choice.id;
    radio.addEventListener('change', () => { draftAvatar = choice.id; updateProfilePreview(); });
    const sample = document.createElement('span');
    sample.className = 'avatar-sample';
    sample.dataset.avatar = choice.id;
    renderAvatar(sample, choice.id, document.getElementById('profileName').value);
    sample.setAttribute('aria-hidden', 'true');
    const caption = document.createElement('span');
    caption.textContent = choice.label;
    label.append(radio, sample, caption);
    grid.appendChild(label);
  });
}

function updateProfilePreview() {
  const name = document.getElementById('profileName').value.trim() || 'Visitante';
  renderAvatar(document.getElementById('profilePreview'), draftAvatar, name);
  document.querySelectorAll('.avatar-sample').forEach(sample => renderAvatar(sample, sample.dataset.avatar, name));
}

function animateContent(element) {
  if (!element?.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  element.animate([{ opacity: .3, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 350, easing: 'cubic-bezier(.22,1,.36,1)' });
}

function closeProfile() {
  const dialog = document.getElementById('profileDialog');
  const restoreFocus = () => { if (profileTrigger?.isConnected) profileTrigger.focus({ preventScroll: true }); };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    dialog.close();
    restoreFocus();
    return;
  }
  if (dialog.classList.contains('is-closing')) return;
  dialog.classList.add('is-closing');
  const finish = () => { dialog.close(); dialog.classList.remove('is-closing'); restoreFocus(); };
  setTimeout(finish, 170);
}

function saveProfileDialog() {
  const input = document.getElementById('profileName');
  const name = input.value.trim();
  if (!name) {
    input.setCustomValidity('Escreva o nome que você quer usar na sala.');
    input.reportValidity();
    return;
  }
  profile.name = name.slice(0, 18);
  profile.avatar = normalizeAvatar(draftAvatar);
  saveProfile();
  syncProfileUI();
  broadcastProfile();
  closeProfile();
  statusMsg('Perfil atualizado. Ficou a sua cara.');
}

function setSettingsTab(name) {
  const selected = name === 'appearance' ? 'appearance' : 'audio';
  ['audio', 'appearance'].forEach(id => {
    const active = id === selected;
    document.getElementById('settings-' + id).hidden = !active;
    const tab = document.getElementById('tab-' + id);
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
}

function updateRange(input) {
  const value = Number(input.value);
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  input.style.setProperty('--progress', ((value - min) / (max - min) * 100) + '%');
  document.getElementById(input.id + 'Value').textContent = value + '%';
}

function retryConnection() {
  if (!peer || peer.destroyed) { location.reload(); return; }
  if (peer.disconnected) {
    updateNetworkStatus('', 'Conectando');
    try { peer.reconnect(); } catch (_) { statusMsg('Não foi possível reconectar. Recarregue a página para tentar novamente.'); }
  } else statusMsg(myId ? 'Sua conexão está disponível. Pode chamar sua gente.' : 'Estabelecendo conexão. Aguarde um instante.');
}

document.querySelectorAll('[role="tablist"]').forEach(list => {
  list.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
    const current = tabs.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click();
    tabs[next].focus();
  });
});
document.getElementById('roomId').addEventListener('input', event => event.target.setCustomValidity(''));
document.getElementById('profileName').addEventListener('input', event => { event.target.setCustomValidity(''); updateProfilePreview(); });
document.getElementById('profileDialog').addEventListener('cancel', event => { event.preventDefault(); closeProfile(); });
document.getElementById('ringOverlay').addEventListener('cancel', event => { event.preventDefault(); declineIncoming(); });
document.querySelectorAll('input[type="range"]').forEach(updateRange);
if (!navigator.mediaDevices?.getDisplayMedia) {
  const share = document.getElementById('shareBtn');
  share.disabled = true;
  share.title = 'Compartilhamento de tela indisponível neste navegador';
  document.getElementById('screenSupportHint').textContent = 'Este navegador permite participar por voz e assistir às transmissões. Para compartilhar sua tela, use um navegador de computador compatível.';
}
setEntryMode(new URLSearchParams(location.search).has('room') ? 'join' : 'create');
syncRoomUI();
