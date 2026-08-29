
const AVATARS = ['🐱','🐶','🦊','🐼','🐵','🦁','🐸','🤖','👾','🦉','🐧','🦄'];

let profile = JSON.parse(localStorage.getItem('callzin_profile') || 'null') || {};
if (!profile.name) profile.name = 'Visitante' + Math.floor(Math.random() * 900 + 100);
if (!profile.avatar) profile.avatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
if (profile.inputVolume === undefined) profile.inputVolume = 100;
if (profile.outputVolume === undefined) profile.outputVolume = 100;
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
if (!profile.screenQuality) profile.screenQuality = isMobile ? 'sd30' : 'fhd60';
if (profile.systemAudio === undefined) profile.systemAudio = true;
function saveProfile() { localStorage.setItem('callzin_profile', JSON.stringify(profile)); }

const SCREEN_QUALITY_PRESETS = {
  fhd60: { width: 1920, height: 1080, frameRate: 60, bitrate: 8000000 },
  fhd30: { width: 1920, height: 1080, frameRate: 30, bitrate: 5000000 },
  hd60:  { width: 1280, height: 720,  frameRate: 60, bitrate: 4000000 },
  hd30:  { width: 1280, height: 720,  frameRate: 30, bitrate: 2500000 },
  sd30:  { width: 854,  height: 480,  frameRate: 30, bitrate: 1200000 },
};

let peer, myId = null, localStream, blankVideoTrack, screenShareAudioTrack = null;
let micOn = true, mySharing = false, inRoom = false, pendingCall = null, deafened = false;
let rawMicStream = null; // faixa crua do microfone atual, pra poder parar antes de trocar de dispositivo
let autoJoinRoomId = null;

const participants = new Map(); // id -> { call, dataConn, name, avatar, sharing }
const tiles = new Map();        // id -> { wrap, video, overlay, circle, label, tag, isLocal }

/* ---------- áudio: barramento único (mic + som da tela) + volume de saída ---------- */
// Em vez de criar/trocar faixas de áudio (o que exigiria renegociar a conexão WebRTC
// no meio da chamada, algo frágil com o PeerJS), mantemos UMA única faixa de saída
// (sentAudioTrack) desde o início da chamada. Trocar de microfone ou ligar/desligar
// o som da tela apenas reconecta as fontes dentro do grafo de áudio — a faixa
// enviada pra rede nunca muda, então nada precisa ser renegociado.
let audioCtx = null;
let mixDestNode = null;   // destino único cujo track é o que de fato sai pra rede
let sentAudioTrack = null;
let micGainNode = null, micSourceNode = null;
let screenGainNode = null, screenSourceNode = null;
let micGainValue = profile.inputVolume / 100;
let outputVolumeValue = profile.outputVolume / 100;

function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}
function ensureMixGraph() {
  ensureAudioCtx();
  if (!mixDestNode) {
    mixDestNode = audioCtx.createMediaStreamDestination();
    sentAudioTrack = mixDestNode.stream.getAudioTracks()[0];
  }
}
function connectMicToMix(rawTrack) {
  ensureMixGraph();
  if (micSourceNode) { try { micSourceNode.disconnect(); } catch (e) {} }
  micSourceNode = audioCtx.createMediaStreamSource(new MediaStream([rawTrack]));
  if (!micGainNode) {
    micGainNode = audioCtx.createGain();
    micGainNode.gain.value = micOn ? micGainValue : 0;
    micGainNode.connect(mixDestNode);
  }
  micSourceNode.connect(micGainNode);
  attachSpeakingAnalyser('local', micSourceNode, true);
}

/* ---------- indicador de fala (borda verde) + medidor de nível do mic ---------- */
// Cada participante (incluindo você) ganha um AnalyserNode ligado à sua fonte de
// áudio. Um único loop de animação lê o volume de todos e liga/desliga a classe
// "speaking" no card correspondente — é assim que dá pra confirmar visualmente
// que sua voz está saindo (a borda do seu próprio card fica verde ao falar).
const speakingAnalysers = new Map(); // id -> { analyser, data, isLocalMic }
function attachSpeakingAnalyser(id, sourceNode, isLocalMic) {
  ensureAudioCtx();
  const prev = speakingAnalysers.get(id);
  if (prev && prev.sourceNode) { try { prev.sourceNode.disconnect(prev.analyser); } catch (e) {} }
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.6;
  sourceNode.connect(analyser); // não conecta ao destino: só serve pra medir, não toca duas vezes
  speakingAnalysers.set(id, { analyser, sourceNode, data: new Uint8Array(analyser.frequencyBinCount), isLocalMic: !!isLocalMic, speaking: false });
}
function detachSpeakingAnalyser(id) {
  const s = speakingAnalysers.get(id);
  if (s) { try { s.sourceNode.disconnect(s.analyser); } catch (e) {} speakingAnalysers.delete(id); }
}
function levelOf(entry) {
  entry.analyser.getByteTimeDomainData(entry.data);
  let sum = 0;
  for (let i = 0; i < entry.data.length; i++) { const v = (entry.data[i] - 128) / 128; sum += v * v; }
  return Math.sqrt(sum / entry.data.length); // RMS aproximado, 0..1
}
const SPEAKING_THRESHOLD = 0.035;
function speakingLoop() {
  speakingAnalysers.forEach((entry, id) => {
    const level = levelOf(entry);
    if (id === 'local' && entry.isLocalMic) {
      const pct = Math.min(100, Math.round((level / 0.5) * 100));
      const fill = document.getElementById('micMeterFill');
      if (fill) fill.style.width = pct + '%';
    }
    const shouldSpeak = level > SPEAKING_THRESHOLD && (id !== 'local' || micOn);
    if (shouldSpeak !== entry.speaking) {
      entry.speaking = shouldSpeak;
      const t = tiles.get(id);
      if (t) t.wrap.classList.toggle('speaking', shouldSpeak);
    }
  });
  requestAnimationFrame(speakingLoop);
}
requestAnimationFrame(speakingLoop);
function connectScreenAudioToMix(rawTrack) {
  ensureMixGraph();
  screenSourceNode = audioCtx.createMediaStreamSource(new MediaStream([rawTrack]));
  if (!screenGainNode) { screenGainNode = audioCtx.createGain(); screenGainNode.gain.value = 1; screenGainNode.connect(mixDestNode); }
  screenSourceNode.connect(screenGainNode);
}
function disconnectScreenAudioFromMix() {
  if (screenSourceNode) { try { screenSourceNode.disconnect(); } catch (e) {} screenSourceNode = null; }
}
function onInputVolumeChange() {
  const val = Number(document.getElementById('inputVolume').value);
  micGainValue = val / 100;
  if (micGainNode && micOn) micGainNode.gain.value = micGainValue;
  profile.inputVolume = val; saveProfile();
}
function onOutputVolumeChange() {
  const val = Number(document.getElementById('outputVolume').value);
  outputVolumeValue = val / 100;
  profile.outputVolume = val; saveProfile();
  applyOutputVolumeAll();
}
function applyOutputVolumeAll() {
  tiles.forEach(t => {
    if (t.isLocal) return;
    t.video.volume = 0;
    if (t.audio) t.audio.volume = outputVolumeValue;
  });
}
// O vídeo remoto fica mudo e um elemento <audio> separado reproduz somente a voz.
// Isso evita que o navegador bloqueie/controle o áudio junto com a transmissão visual.
async function applyOutputToVideo(video, isLocal) {
  if (isLocal) return;
  video.muted = true;
  video.volume = 0;
  if (profile.speakerId && typeof video.setSinkId === 'function') {
    try { await video.setSinkId(profile.speakerId); } catch (e) {}
  }
}
async function applyOutputToAudio(audio, isLocal) {
  if (isLocal || !audio) return;
  audio.muted = deafened;
  audio.volume = outputVolumeValue;
  if (profile.speakerId && typeof audio.setSinkId === 'function') {
    try { await audio.setSinkId(profile.speakerId); }
    catch (e) { statusMsg('Não consegui usar o alto-falante selecionado: ' + (e.message || e.name)); }
  }
}
function resumeAllRemoteAudio() {
  tiles.forEach(t => {
    if (t.isLocal || !t.audio || !t.audio.srcObject || deafened) return;
    applyOutputToAudio(t.audio, false).then(() => t.audio.play().catch(() => {}));
  });
}
window.addEventListener('pointerdown', resumeAllRemoteAudio, { passive: true });
window.addEventListener('keydown', resumeAllRemoteAudio);

const statusEl = document.getElementById('status');
function statusMsg(text) { statusEl.textContent = text; }

/* ---------- profile UI ---------- */
document.getElementById('profileName').value = profile.name;
document.getElementById('profileAvatar').textContent = profile.avatar;
document.getElementById('homeName').textContent = profile.name;
document.getElementById('homeAvatar').textContent = profile.avatar;
document.getElementById('inputVolume').value = profile.inputVolume;
document.getElementById('outputVolume').value = profile.outputVolume;

document.getElementById('profileName').addEventListener('input', e => {
  profile.name = e.target.value.trim() || 'Visitante';
  saveProfile();
  document.getElementById('homeName').textContent = profile.name;
  updateTileLabel('local', profile.name);
  broadcastProfile();
});

function cycleAvatar() {
  const idx = AVATARS.indexOf(profile.avatar);
  profile.avatar = AVATARS[(idx + 1) % AVATARS.length];
  saveProfile();
  document.getElementById('profileAvatar').textContent = profile.avatar;
  document.getElementById('homeAvatar').textContent = profile.avatar;
  updateTileLabel('local', undefined, profile.avatar);
  broadcastProfile();
}

/* ---------- plano de fundo (troca com localStorage, começa em "nenhum") ---------- */
const BACKGROUNDS = [
  { id: 'ds3-8k',        label: 'Dark Souls III',      url: 'https://res.cloudinary.com/xuxmagdy/image/upload/v1785894360/dark-souls-3-8k-om-1440x900_ygoxeg.jpg' },
  { id: 'ds3-2016',      label: 'Dark Souls III',      url: 'https://res.cloudinary.com/xuxmagdy/image/upload/v1785860922/dark-souls-3-2016-video-game-1440x900_bjkwdq.jpg' },
  { id: 'ds-remastered', label: 'Dark Souls Remastered', url: 'https://res.cloudinary.com/xuxmagdy/image/upload/v1785860901/dark-souls-remastered-4k-3x-1440x900_ab2srw.jpg' },
  { id: 'ds3-graphics',  label: 'Dark Souls III',      url: 'https://res.cloudinary.com/xuxmagdy/image/upload/v1785860889/dark-souls-3-graphics-4k-1440x900_zzbhyl.jpg' },
  { id: 'batman-statue', label: 'Batman',              url: 'https://res.cloudinary.com/xuxmagdy/image/upload/v1785549211/batman-statue-5k-nq-1366x768_umnqpm.jpg' },
  { id: 'batman-knight', label: 'Batman',              url: 'https://res.cloudinary.com/xuxmagdy/image/upload/v1785549208/batman-black-knight-0t-1366x768_hp5yv1.jpg' },
];

let bgId = localStorage.getItem('callzin_bg') || 'none'; // começa sem imagem, só o fundo padrão
let bgActiveLayer = 'A';

function applyBackground(id, persist) {
  bgId = id;
  if (persist) localStorage.setItem('callzin_bg', id);
  const overlay = document.getElementById('bgOverlay');
  const bg = BACKGROUNDS.find(b => b.id === id);

  if (!bg) {
    document.getElementById('bgLayerA').classList.remove('visible');
    document.getElementById('bgLayerB').classList.remove('visible');
    overlay.classList.remove('visible');
  } else {
    const showId = bgActiveLayer === 'A' ? 'bgLayerB' : 'bgLayerA';
    const hideId = bgActiveLayer === 'A' ? 'bgLayerA' : 'bgLayerB';
    const showEl = document.getElementById(showId);
    showEl.style.backgroundImage = `url('${bg.url}')`;
    showEl.classList.add('visible');
    document.getElementById(hideId).classList.remove('visible');
    overlay.classList.add('visible');
    bgActiveLayer = bgActiveLayer === 'A' ? 'B' : 'A';
  }
  renderBgGrid();
}

function renderBgGrid() {
  const grid = document.getElementById('bgGrid');
  if (!grid) return;
  const checkSvg = '<span class="check"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
  const noneSvg = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  let html = `<div class="bg-thumb none-thumb ${bgId === 'none' ? 'selected' : ''}" onclick="applyBackground('none', true)" title="Nenhum">
    ${noneSvg}${checkSvg}
  </div>`;
  html += BACKGROUNDS.map(b => `
    <div class="bg-thumb ${bgId === b.id ? 'selected' : ''}" style="background-image:url('${b.url}')" onclick="applyBackground('${b.id}', true)" title="${b.label}">
      ${checkSvg}
      <span class="bg-thumb-label">${b.label}</span>
    </div>
  `).join('');
  grid.innerHTML = html;
}
applyBackground(bgId, false);

/* ---------- nav ---------- */
function setView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  document.querySelectorAll('.navitem').forEach(b => b.classList.toggle('active', b.dataset.view === view));
}

/* ---------- peer setup ---------- */
// Além dos servidores STUN, incluímos servidores TURN públicos (Open Relay Project).
// Sem TURN, duas pessoas atrás de redes mais restritas (roteador de operadora, Wi-Fi
// de empresa/faculdade, dupla-NAT etc.) muitas vezes não conseguem se conectar direto
// e a chamada nunca fecha — isso é a causa mais comum de "a call não funciona".
peer = new Peer(undefined, {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ],
    iceTransportPolicy: 'all',
    sdpSemantics: 'unified-plan',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  }
});
peer.on('open', id => {
  myId = id;
  document.getElementById('sidebarMyid').textContent = id;
  updateInviteLink();
  if (autoJoinRoomId) { document.getElementById('roomId').value = autoJoinRoomId; enterRoom(); autoJoinRoomId = null; }
});
const PEER_ERROR_MESSAGES = {
  'peer-unavailable': 'Não encontrei ninguém com esse ID de sala. Confira se copiou certo ou se a pessoa ainda está na sala.',
  'network': 'Falha de rede ao tentar conectar. Veja sua internet e tente de novo.',
  'webrtc': 'O navegador teve um problema para abrir a conexão de voz/vídeo (WebRTC).',
  'browser-incompatible': 'Seu navegador não tem suporte completo a chamadas — tente Chrome, Edge ou Firefox atualizados.',
  'disconnected': 'Você caiu do servidor de sinalização. Tentando reconectar...',
  'server-error': 'O servidor de sinalização teve um problema. Tente novamente em instantes.',
  'socket-error': 'Erro de conexão com o servidor de sinalização.',
  'socket-closed': 'A conexão com o servidor de sinalização caiu. Tentando reconectar...',
  'unavailable-id': 'Esse ID já está em uso, gerando outro automaticamente...'
};
peer.on('error', err => {
  statusMsg(PEER_ERROR_MESSAGES[err.type] || ('Erro: ' + err.type));
  if (err.type === 'unavailable-id') { setTimeout(() => { peer.reconnect(); }, 500); }
  if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
    updateConnBadge('bad', 'sem conexão com o servidor');
  }
});
peer.on('disconnected', () => {
  updateConnBadge('bad', 'reconectando...');
  setTimeout(() => { try { peer.reconnect(); } catch (e) {} }, 1000);
});
peer.on('close', () => { updateConnBadge('bad', 'desconectado'); });

peer.on('call', incoming => {
  const id = incoming.peer;
  if (inRoom) {
    incoming.answer(localStream);
    if (participants.has(id)) { participants.get(id).call = incoming; wireCall(id, incoming); }
    else { wireParticipant(id, incoming, peer.connect(id)); }
  } else {
    pendingCall = incoming;
    document.getElementById('ringOverlay').style.display = 'flex';
  }
});

peer.on('connection', dataConn => {
  const id = dataConn.peer;
  if (!inRoom) { dataConn.close(); return; }
  if (participants.has(id)) { participants.get(id).dataConn = dataConn; wireDataConn(id, dataConn); }
  else { wireParticipant(id, peer.call(id, localStream), dataConn); }
});

/* ---------- mic ---------- */
function makeBlankVideoTrack() {
  const canvas = document.createElement('canvas');
  canvas.width = 2; canvas.height = 2;
  return canvas.captureStream(1).getVideoTracks()[0];
}

async function populateMicSelect() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');
    const sel = document.getElementById('micSelect');
    sel.innerHTML = '';
    mics.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || ('Microfone ' + (i + 1));
      sel.appendChild(opt);
    });
    if (profile.micId && mics.some(d => d.deviceId === profile.micId)) sel.value = profile.micId;
    await updateDeviceHintForPermission(mics);
  } catch (e) { /* sem permissão ainda */ }
}
// O navegador só mostra a lista real de microfones (com nomes) depois que o site
// recebe permissão pelo menos uma vez. Antes disso, ele devolve só 1 entrada
// genérica ("Microfone 1") por privacidade — não é bug do Callzin, é assim que o
// Chrome/Edge/Firefox funcionam pra qualquer site (o Discord só mostra tudo certo
// porque é um app instalado, com permissão de sistema já concedida).
async function updateDeviceHintForPermission(mics) {
  const hint = document.getElementById('deviceStatusHint');
  if (!hint) return;
  const hasRealLabels = mics.some(d => d.label);
  if (hasRealLabels) {
    hint.style.color = '#8891a3';
    hint.textContent = 'Dispositivos liberados! Fale perto do microfone pra ver a barra verde se mexer.';
    return;
  }
  let stateMsg = 'ainda não foi liberada';
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const status = await navigator.permissions.query({ name: 'microphone' });
      if (status.state === 'denied') stateMsg = 'foi negada';
    }
  } catch (e) { /* Firefox e alguns navegadores não suportam consultar essa permissão */ }
  hint.style.color = '#ffcd3c';
  hint.textContent = mics.length <= 1
    ? '⚠️ Só aparece "Microfone 1" genérico porque a permissão de microfone ' + stateMsg + ' pra este site. Clique em "ativar microfone" acima e, quando o navegador perguntar, escolha Permitir. Se não aparecer nenhum pop-up, clique no cadeado/ícone ao lado do endereço do site e libere o microfone manualmente.'
    : hint.textContent;
}
async function populateSpeakerSelect() {
  const sel = document.getElementById('speakerSelect');
  const hint = document.getElementById('speakerHint');
  const supported = typeof HTMLMediaElement !== 'undefined' && !!HTMLMediaElement.prototype.setSinkId;
  if (!supported) {
    sel.innerHTML = '<option>Padrão do sistema</option>';
    sel.disabled = true;
    hint.textContent = 'Seu navegador não permite escolher a saída de áudio (funciona no Chrome/Edge).';
    return;
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const speakers = devices.filter(d => d.kind === 'audiooutput');
    sel.innerHTML = '';
    speakers.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || ('Alto-falante ' + (i + 1));
      sel.appendChild(opt);
    });
    if (profile.speakerId && speakers.some(d => d.deviceId === profile.speakerId)) sel.value = profile.speakerId;
    hint.textContent = 'Pode trocar o alto-falante mesmo durante a chamada.';
  } catch (e) { /* sem permissão ainda */ }
}
function onSpeakerChange() {
  const id = document.getElementById('speakerSelect').value;
  if (!id) return;
  profile.speakerId = id; saveProfile();
  tiles.forEach(t => {
    if (t.isLocal) return;
    if (t.audio && typeof t.audio.setSinkId === 'function') {
      t.audio.setSinkId(id).catch(e => statusMsg('Não consegui trocar a saída: ' + (e.message || e.name)));
    }
    if (typeof t.video.setSinkId === 'function') {
      t.video.setSinkId(id).catch(() => {});
    }
  });
}
navigator.mediaDevices.enumerateDevices().then(() => { populateMicSelect(); populateSpeakerSelect(); }).catch(() => {});
navigator.mediaDevices.ondevicechange = () => { populateMicSelect(); populateSpeakerSelect(); };

function micErrorMessage(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Permissão de microfone negada. Clique no cadeado ao lado do endereço e libere o microfone pra esse site.';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'Nenhum microfone encontrado com esse dispositivo. Ele pode ter sido desconectado.';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'O microfone está sendo usado por outro programa (ex.: outro app de voz, OBS, etc.) e não deixou o navegador acessá-lo. Feche o outro programa e tente de novo.';
  if (name === 'OverconstrainedError') return 'Esse dispositivo não aceitou a configuração pedida. Tente escolher outro microfone.';
  return 'Não consegui acessar o microfone: ' + (e && (e.message || e.name) || e);
}

async function onMicChange() {
  const id = document.getElementById('micSelect').value;
  if (!id) return;
  profile.micId = id; saveProfile();
  if (!localStream) return;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: id }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    // solta a faixa antiga antes de trocar — alguns dispositivos (mics virtuais como
    // WO Mic / Steam Streaming Microphone) só liberam acesso a um consumidor por vez
    // e "travam" se a faixa anterior continuar aberta, dando a impressão de que a
    // troca "não funciona".
    if (rawMicStream) rawMicStream.getTracks().forEach(t => t.stop());
    rawMicStream = newStream;
    connectMicToMix(newStream.getAudioTracks()[0]);
    statusMsg('Microfone atualizado.');
  } catch (e) { statusMsg(micErrorMessage(e)); }
}

async function getLocalStream() {
  if (localStream) return localStream;
  blankVideoTrack = makeBlankVideoTrack();
  ensureMixGraph();
  // se já existia uma captura de teste (do botão "ativar dispositivos"), solta ela
  // antes de pedir uma nova — evita dois pedidos concorrentes pro mesmo microfone
  if (rawMicStream) { rawMicStream.getTracks().forEach(t => t.stop()); rawMicStream = null; }
  let micStream = null;
  const baseAudio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const audioConstraints = profile.micId ? { ...baseAudio, deviceId: { exact: profile.micId } } : baseAudio;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  } catch (e) {
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio: baseAudio }); }
    catch (e2) { statusMsg(micErrorMessage(e2) + ' Entrando só com vídeo/tela por enquanto.'); }
  }
  if (micStream) {
    rawMicStream = micStream;
    connectMicToMix(micStream.getAudioTracks()[0]);
    if (micGainNode) micGainNode.gain.value = micOn ? micGainValue : 0; // garante que não fique mudo por causa do teste anterior
  }
  localStream = new MediaStream();
  localStream.addTrack(blankVideoTrack);
  localStream.addTrack(sentAudioTrack);
  populateMicSelect();
  populateSpeakerSelect();
  return localStream;
}

/* ---------- ativar dispositivos / testar antes mesmo de entrar numa sala ---------- */
async function activateDevices() {
  const btn = document.getElementById('activateDevicesBtn');
  btn.disabled = true; btn.textContent = 'ativando...';
  try {
    const testStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    if (!localStream) {
      // ainda não entrou em sala: usa essa captura só pra mostrar o medidor de nível
      // e revelar os nomes reais dos dispositivos, sem mandar áudio pra ninguém
      if (rawMicStream) rawMicStream.getTracks().forEach(t => t.stop());
      rawMicStream = testStream;
      connectMicToMix(testStream.getAudioTracks()[0]);
      if (micGainNode) micGainNode.gain.value = 0; // não solta som, só alimenta o medidor
    } else {
      testStream.getTracks().forEach(t => t.stop()); // já tem stream ativo, só precisava da permissão
    }
    await populateMicSelect();
    await populateSpeakerSelect();
    btn.textContent = 'dispositivos ativados';
  } catch (e) {
    statusMsg(micErrorMessage(e));
    const hint = document.getElementById('deviceStatusHint');
    hint.style.color = '#fbbf24';
    hint.textContent = micErrorMessage(e);
    btn.textContent = 'ativar microfone e ver dispositivos';
  }
  btn.disabled = false;
}
function testSpeaker() {
  try {
    ensureAudioCtx();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0.15;
    osc.frequency.value = 440;
    osc.connect(gain);
    const testEl = new Audio();
    // usamos um elemento <audio> real pra poder aplicar setSinkId (saída escolhida);
    // o osc alimenta um MediaStreamDestination que vira a fonte desse elemento
    const dest = audioCtx.createMediaStreamDestination();
    gain.connect(dest);
    testEl.srcObject = dest.stream;
    testEl.volume = outputVolumeValue;
    if (profile.speakerId && typeof testEl.setSinkId === 'function') testEl.setSinkId(profile.speakerId).catch(() => {});
    osc.start();
    testEl.play().catch(() => {});
    setTimeout(() => { osc.stop(); testEl.pause(); }, 700);
  } catch (e) { statusMsg('Não consegui tocar o som de teste: ' + (e.message || e.name)); }
}

function onScreenQualityChange() {
  profile.screenQuality = document.getElementById('screenQualitySelect').value;
  saveProfile();
}
function onSystemAudioCheckChange() {
  profile.systemAudio = document.getElementById('systemAudioCheck').checked;
  saveProfile();
}
document.getElementById('screenQualitySelect').value = profile.screenQuality;
document.getElementById('systemAudioCheck').checked = profile.systemAudio;

function copyId() {
  navigator.clipboard.writeText(myId || '');
  statusMsg('ID copiado!');
}

/* ---------- status de conexão ---------- */
function updateConnBadge(state, text) {
  const dot = document.getElementById('connDot');
  const label = document.getElementById('connText');
  if (!dot || !label) return;
  dot.classList.remove('ok', 'bad');
  if (state) dot.classList.add(state);
  label.textContent = text;
}

/* ---------- ensurdecer (não ouvir ninguém, mas continua enviando seu áudio) ---------- */
function toggleDeafen() {
  deafened = !deafened;
  document.getElementById('deafenBtn').classList.toggle('deafened', deafened);
  tiles.forEach(t => {
    if (t.isLocal) return;
    t.video.muted = true;
    if (t.audio) t.audio.muted = deafened;
  });
}

/* ---------- link de convite (?room=SEU_ID) ---------- */
function copyInviteLink() {
  const input = document.getElementById('inviteLink');
  navigator.clipboard.writeText(input.value);
  statusMsg('Link copiado!');
}
function updateInviteLink() {
  if (!myId) return;
  const url = new URL(location.href);
  url.search = ''; url.hash = '';
  url.searchParams.set('room', myId);
  document.getElementById('inviteLink').value = url.toString();
  document.getElementById('inviteBox').style.display = 'block';
}
(function readRoomFromUrl() {
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (room) { autoJoinRoomId = room; document.getElementById('roomId').value = room; statusMsg('Entrando na sala do link...'); }
})();

/* ---------- atalho de teclado: M alterna o microfone ---------- */
document.addEventListener('keydown', e => {
  if (e.key.toLowerCase() !== 'm') return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return; // não atrapalha quando o usuário está digitando
  if (inRoom) toggleMic();
});

/* ---------- tiles ---------- */
function ensureTile(id, { name, avatar, isLocal } = {}) {
  if (tiles.has(id)) return tiles.get(id);
  const wrap = document.createElement('div');
  wrap.className = 'vwrap';
  wrap.id = 'tile-' + id;

  const video = document.createElement('video');
  video.autoplay = true; video.playsInline = true;
  video.muted = true;

  const audio = document.createElement('audio');
  audio.className = 'remote-audio';
  audio.autoplay = true;
  audio.playsInline = true;
  audio.muted = !!isLocal || deafened;

  const overlay = document.createElement('div');
  overlay.className = 'avatar-overlay';
  const circle = document.createElement('div');
  circle.className = 'avatar-circle';
  circle.textContent = avatar || '🙂';
  const label = document.createElement('span');
  label.className = 'avatar-label';
  label.textContent = isLocal ? 'tela não compartilhada' : 'aguardando transmissão';
  overlay.append(circle, label);

  const fsBtn = document.createElement('button');
  fsBtn.className = 'fs-btn'; fsBtn.title = 'tela cheia';
  fsBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 9V5a1 1 0 011-1h4M20 9V5a1 1 0 00-1-1h-4M4 15v4a1 1 0 001 1h4M20 15v4a1 1 0 01-1 1h-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  fsBtn.onclick = () => toggleFullscreen('tile-' + id);

  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = (name || '...') + (isLocal ? ' (você)' : '');

  wrap.append(video, audio, overlay, fsBtn, tag);
  document.getElementById('videos').appendChild(wrap);

  const obj = { wrap, video, audio, overlay, circle, label, tag, isLocal };
  tiles.set(id, obj);
  return obj;
}
function removeTile(id) { const t = tiles.get(id); if (t) { t.wrap.remove(); tiles.delete(id); } }
function updateTileLabel(id, name, avatar) {
  const t = tiles.get(id); if (!t) return;
  if (name !== undefined) t.tag.textContent = name + (t.isLocal ? ' (você)' : '');
  if (avatar !== undefined) t.circle.textContent = avatar;
}
function setTileSharing(id, sharing) {
  const t = tiles.get(id); if (t) t.overlay.style.display = sharing ? 'none' : 'flex';
}
function updateSpotlight() {
  const videosEl = document.getElementById('videos');
  let spotlightId = mySharing ? 'local' : null;
  if (!spotlightId) for (const [id, p] of participants) { if (p.sharing) { spotlightId = id; break; } }

  let thumbrow = document.getElementById('thumbrow');
  if (spotlightId) {
    videosEl.classList.add('has-spotlight');
    if (!thumbrow) { thumbrow = document.createElement('div'); thumbrow.id = 'thumbrow'; thumbrow.className = 'thumbrow'; videosEl.appendChild(thumbrow); }
    tiles.forEach((t, id) => {
      if (id === spotlightId) { t.wrap.classList.add('spotlight'); t.wrap.classList.remove('thumb'); videosEl.insertBefore(t.wrap, thumbrow); }
      else { t.wrap.classList.remove('spotlight'); t.wrap.classList.add('thumb'); thumbrow.appendChild(t.wrap); }
    });
  } else {
    videosEl.classList.remove('has-spotlight');
    tiles.forEach(t => { t.wrap.classList.remove('spotlight', 'thumb'); videosEl.appendChild(t.wrap); });
    if (thumbrow) thumbrow.remove();
  }
}
function updateParticipantCount() {
  const n = participants.size + 1;
  document.getElementById('roomCount').textContent = 'Sala • ' + n + (n === 1 ? ' pessoa' : ' pessoas');
}
function toggleFullscreen(wrapId) {
  const el = document.getElementById(wrapId);
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen();
}

/* ---------- mesh (multi-pessoa) ---------- */
function wireCall(id, call) {
  call.on('stream', async stream => {
    const t = tiles.get(id) || ensureTile(id, participants.get(id) || {});

    // O vídeo remoto serve só para a imagem. A voz é reproduzida pelo <audio>.
    t.video.srcObject = stream;
    t.video.muted = true;
    t.audio.srcObject = stream;
    await applyOutputToVideo(t.video, t.isLocal);
    await applyOutputToAudio(t.audio, t.isLocal);

    try {
      await t.audio.play();
    } catch (e) {
      statusMsg('Clique uma vez na página para liberar o áudio da chamada.');
    }

    try {
      t.video.play().catch(() => {});
    } catch (e) {}

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      statusMsg('A conexão com ' + (participants.get(id)?.name || 'o participante') + ' chegou sem áudio.');
    } else {
      audioTracks.forEach(track => {
        track.onmute = () => statusMsg('O microfone de ' + (participants.get(id)?.name || 'o participante') + ' está mudo.');
        track.onunmute = () => { if (!deafened) resumeAllRemoteAudio(); };
        track.onended = () => statusMsg('O áudio de ' + (participants.get(id)?.name || 'o participante') + ' foi encerrado.');
      });
    }

    // indicador verde baseado no áudio recebido
    try {
      ensureAudioCtx();
      const src = audioCtx.createMediaStreamSource(stream);
      attachSpeakingAnalyser(id, src, false);
    } catch (e) {}

    // no celular, limita o bitrate de recebimento de vídeo pra evitar travamento
    // (o transmissor manda em alta qualidade, mas o receiver descarta o excesso)
    if (isMobile && call.peerConnection) {
      try {
        const receivers = call.peerConnection.getReceivers();
        receivers.forEach(receiver => {
          if (receiver.track && receiver.track.kind === 'video') {
            // jitterBufferTarget=0 reduz delay; degradationPreference prioriza framerate
            if (receiver.jitterBufferTarget !== undefined) receiver.jitterBufferTarget = 0;
            const params = receiver.getParameters ? receiver.getParameters() : null;
            if (params && params.encodings && params.encodings.length) {
              params.encodings[0].maxBitrate = 800000; // 800kbps máximo no celular
              receiver.setParameters(params).catch(() => {});
            }
          }
          if (receiver.track && receiver.track.kind === 'audio') {
            if (receiver.jitterBufferTarget !== undefined) receiver.jitterBufferTarget = 0;
          }
        });
      } catch (e) {}
    }
  });
  call.on('close', () => removeParticipant(id));
  call.on('error', err => {
    statusMsg('Conexão com um participante caiu (' + (err && err.type || 'erro') + '). Removendo da sala.');
    removeParticipant(id);
  });

  if (call.peerConnection) {
    call.peerConnection.oniceconnectionstatechange = () => {
      const state = call.peerConnection.iceConnectionState;
      if (state === 'failed' || state === 'disconnected') {
        updateConnBadge('bad', 'conexão instável');
      } else if (state === 'connected' || state === 'completed') {
        updateConnBadge('ok', 'conectado');
      }
    };
  }
}
function wireDataConn(id, dataConn) {
  dataConn.on('open', () => {
    dataConn.send({ type: 'profile', name: profile.name, avatar: profile.avatar, sharing: mySharing });
    const others = [...participants.keys()].filter(x => x !== id);
    if (others.length) dataConn.send({ type: 'peers', list: others });
  });
  dataConn.on('data', msg => {
    const p = participants.get(id); if (!p) return;
    if (msg.type === 'profile') {
      p.name = msg.name; p.avatar = msg.avatar;
      updateTileLabel(id, p.name, p.avatar);
      if (msg.sharing !== undefined) { p.sharing = msg.sharing; setTileSharing(id, p.sharing); updateSpotlight(); }
    } else if (msg.type === 'sharing') {
      p.sharing = msg.value; setTileSharing(id, p.sharing); updateSpotlight();
    } else if (msg.type === 'peers') {
      msg.list.forEach(pid => { if (pid !== myId && pid !== id) connectToPeer(pid); });
    }
  });
  dataConn.on('close', () => removeParticipant(id));
}
function wireParticipant(id, call, dataConn) {
  if (!participants.has(id)) participants.set(id, { call: null, dataConn: null, name: 'Participante', avatar: '🙂', sharing: false });
  const p = participants.get(id);
  if (call) { p.call = call; wireCall(id, call); }
  if (dataConn) { p.dataConn = dataConn; wireDataConn(id, dataConn); }
  ensureTile(id, { name: p.name, avatar: p.avatar });
  updateParticipantCount();
}
function connectToPeer(id) {
  if (id === myId || participants.has(id)) return;
  wireParticipant(id, peer.call(id, localStream), peer.connect(id));
  // se em 20s ninguém respondeu, avisa — geralmente é ID errado, a pessoa não está
  // mais na sala, ou um firewall/rede muito restritiva bloqueando a conexão
  setTimeout(() => {
    if (!participants.has(id)) return;
    const p = participants.get(id);
    const state = p.call && p.call.peerConnection && p.call.peerConnection.iceConnectionState;
    if (state !== 'connected' && state !== 'completed') {
      statusMsg('Ainda não consegui conectar com "' + id + '". Confira se o ID está certo e se a pessoa ainda está na sala — se persistir, pode ser bloqueio de rede/firewall.');
    }
  }, 20000);
}
function removeParticipant(id) {
  if (!participants.has(id)) return;
  participants.delete(id);
  detachSpeakingAnalyser(id);
  removeTile(id);
  updateSpotlight();
  updateParticipantCount();
  if (participants.size === 0) updateConnBadge('', 'sozinho na sala');
}

/* ---------- ring (chamada avulsa fora de sala) ---------- */
async function acceptIncoming() {
  if (!pendingCall) return;
  document.getElementById('ringOverlay').style.display = 'none';
  statusMsg('Conectando...');
  try {
    await getLocalStream();
    inRoom = true;
    ensureTile('local', { name: profile.name, avatar: profile.avatar, isLocal: true });
    tiles.get('local').video.srcObject = localStream;
    pendingCall.answer(localStream);
    wireParticipant(pendingCall.peer, pendingCall, peer.connect(pendingCall.peer));
    updateParticipantCount();
    setView('room');
  } catch (e) { statusMsg('Não consegui acessar o microfone: ' + (e.message || e.name)); }
  pendingCall = null;
}
function declineIncoming() {
  if (pendingCall) pendingCall.close();
  pendingCall = null;
  document.getElementById('ringOverlay').style.display = 'none';
}

/* ---------- entrar / sair da sala ---------- */
async function enterRoom() {
  const val = document.getElementById('roomId').value.trim();
  statusMsg('Conectando...');
  try { await getLocalStream(); }
  catch (e) { statusMsg('Não consegui acessar o microfone: ' + (e.message || e.name)); return; }
  inRoom = true;
  ensureTile('local', { name: profile.name, avatar: profile.avatar, isLocal: true });
  tiles.get('local').video.srcObject = localStream;
  updateParticipantCount();
  updateConnBadge(val ? '' : '', val ? 'conectando...' : 'sozinho na sala');
  if (val) connectToPeer(val);
  statusMsg('');
  setView('room');
}
function leaveRoom() {
  participants.forEach((p, id) => { if (p.call) p.call.close(); if (p.dataConn) p.dataConn.close(); detachSpeakingAnalyser(id); });
  participants.clear();
  tiles.forEach(t => t.wrap.remove());
  tiles.clear();
  const thumbrow = document.getElementById('thumbrow'); if (thumbrow) thumbrow.remove();
  document.getElementById('videos').classList.remove('has-spotlight');
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (rawMicStream) { rawMicStream.getTracks().forEach(t => t.stop()); rawMicStream = null; }
  if (screenShareAudioTrack) { screenShareAudioTrack.stop(); screenShareAudioTrack = null; }
  detachSpeakingAnalyser('local');
  mySharing = false; inRoom = false; deafened = false;
  document.getElementById('shareBtn').classList.remove('sharing');
  document.getElementById('deafenBtn').classList.remove('deafened');
  const meterFill = document.getElementById('micMeterFill'); if (meterFill) meterFill.style.width = '0%';
  updateConnBadge('', 'conectando...');
  setView('home');
}

/* ---------- controles ---------- */
function toggleMic() {
  micOn = !micOn;
  if (micGainNode) micGainNode.gain.value = micOn ? micGainValue : 0;
  if (localStream) {
    localStream.getAudioTracks().forEach(track => { track.enabled = micOn; });
  }
  document.getElementById('micBtn').classList.toggle('off', !micOn);
}

function boostBitrate(sender, quality) {
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = quality.bitrate;
    if (params.encodings[0].maxFramerate !== undefined || true) params.encodings[0].maxFramerate = quality.frameRate;
    sender.setParameters(params).catch(() => {});
  } catch (e) {}
}
function replaceVideoTrackEverywhere(track, quality) {
  const q = quality || SCREEN_QUALITY_PRESETS[profile.screenQuality] || SCREEN_QUALITY_PRESETS.fhd60;
  participants.forEach(p => {
    if (p.call && p.call.peerConnection) {
      const sender = p.call.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) { sender.replaceTrack(track); boostBitrate(sender, q); }
    }
  });
}
function broadcastSharing(value) {
  participants.forEach(p => { if (p.dataConn && p.dataConn.open) p.dataConn.send({ type: 'sharing', value }); });
}
function broadcastProfile() {
  participants.forEach(p => { if (p.dataConn && p.dataConn.open) p.dataConn.send({ type: 'profile', name: profile.name, avatar: profile.avatar, sharing: mySharing }); });
}

async function toggleScreen() {
  if (!mySharing) {
    const quality = SCREEN_QUALITY_PRESETS[profile.screenQuality] || SCREEN_QUALITY_PRESETS.fhd60;
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: quality.width }, height: { ideal: quality.height }, frameRate: { ideal: quality.frameRate, max: quality.frameRate } },
        audio: profile.systemAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
        // impede que a própria aba do Callzin seja capturada — sem isso, o áudio do
        // sistema pega de volta a voz de quem está ouvindo (tocando aqui na página)
        // e manda de volta pra pessoa, causando eco. Também some da lista de opções
        // pra compartilhar, então dá pra escolher só outra aba, janela ou a tela toda.
        selfBrowserSurface: 'exclude',
        systemAudio: profile.systemAudio ? 'include' : 'exclude'
      });
      const screenTrack = screenStream.getVideoTracks()[0];
      const oldTrack = localStream.getVideoTracks()[0];
      localStream.removeTrack(oldTrack);
      localStream.addTrack(screenTrack);
      tiles.get('local').video.srcObject = localStream;
      replaceVideoTrackEverywhere(screenTrack, quality);

      // som do sistema/aba compartilhada (nem toda fonte oferece isso) — entra no
      // mesmo barramento de áudio que já está sendo enviado, sem precisar renegociar nada
      let audioTrack = screenStream.getAudioTracks()[0];
      if (audioTrack) {
        const settings = screenTrack.getSettings ? screenTrack.getSettings() : {};
        // Eco: quando a fonte NÃO é uma aba específica (é tela inteira ou janela),
        // o "áudio do sistema" do Windows/Mac captura TUDO que está tocando — inclusive
        // a própria chamada (a voz de quem está te ouvindo saindo dos seus alto-falantes).
        // Isso volta pra rede e a pessoa acaba ouvindo a própria voz duplicada. Como não
        // dá pra filtrar só essa parte, a forma segura é descartar o áudio nesse caso.
        if (settings.displaySurface && settings.displaySurface !== 'browser') {
          audioTrack.stop();
          audioTrack = null;
          statusMsg('Áudio do sistema desligado nessa transmissão: você escolheu compartilhar a tela/janela inteira, e isso causaria eco (as pessoas ouviriam a própria voz de volta). Se quiser levar áudio, compartilhe uma ABA específica (ex.: uma música) em vez da tela toda.');
        }
      }
      if (audioTrack) {
        screenShareAudioTrack = audioTrack;
        connectScreenAudioToMix(audioTrack);
      } else if (profile.systemAudio && !statusEl.textContent) {
        statusMsg('A fonte escolhida não enviou áudio (marque a opção de compartilhar áudio na hora de selecionar).');
      }

      screenTrack.onended = () => stopScreenShare();
      mySharing = true;
      document.getElementById('shareBtn').classList.add('sharing');
      setTileSharing('local', true);
      broadcastSharing(true);
      updateSpotlight();
    } catch (e) { /* usuário cancelou a seleção */ }
  } else {
    stopScreenShare();
  }
}
function stopScreenShare() {
  const oldTrack = localStream.getVideoTracks()[0];
  if (oldTrack) { localStream.removeTrack(oldTrack); oldTrack.stop(); }
  localStream.addTrack(blankVideoTrack);
  if (screenShareAudioTrack) {
    disconnectScreenAudioFromMix();
    screenShareAudioTrack.stop();
    screenShareAudioTrack = null;
  }
  tiles.get('local').video.srcObject = localStream;
  replaceVideoTrackEverywhere(blankVideoTrack);
  mySharing = false;
  document.getElementById('shareBtn').classList.remove('sharing');
  setTileSharing('local', false);
  broadcastSharing(false);
  updateSpotlight();
}
