const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

// A small DOM/media adapter exercises the real scripts without a network,
// microphone, speaker, or screen capture permission.
function app({ saved, reducedMotion = true, connected = true } = {}) {
  let document;
  const animations = [];
  const timers = new Map();
  let timerId = 0;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attrs = {};
      this.dataset = {};
      this.value = '';
      this.hidden = false;
      this.inert = false;
      this.listeners = {};
      this.style = { setProperty(name, value) { this[name] = value; } };
      this._text = '';
      this.className = '';
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        add: name => { if (!this.classList.contains(name)) this.className = (this.className + ' ' + name).trim(); },
        remove: name => { this.className = this.className.split(/\s+/).filter(item => item !== name).join(' '); },
        toggle: (name, force) => {
          const active = force === undefined ? !this.classList.contains(name) : force;
          this.classList[active ? 'add' : 'remove'](name);
          return active;
        }
      };
    }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.children = []; }
    set innerHTML(value) { this._html = value; this.children = []; this._text = ''; }
    get innerHTML() { return this._html || ''; }
    append(...children) {
      for (const child of children) {
        if (child.parentElement) child.remove();
        child.parentElement = this;
        this.children.push(child);
      }
    }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...children) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this._text = ''; this.append(...children); }
    insertBefore(child, before) {
      if (child.parentElement) child.remove();
      child.parentElement = this;
      const index = this.children.indexOf(before);
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
    }
    remove() {
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    }
    setAttribute(name, value) {
      this.attrs[name] = String(value);
      if (name === 'class') this.className = value;
      if (name === 'id') this.id = value;
      if (name.startsWith('data-')) this.dataset[name.slice(5)] = value;
    }
    getAttribute(name) { return this.attrs[name] ?? null; }
    removeAttribute(name) { delete this.attrs[name]; }
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
    get isConnected() { return this === document || !!this.parentElement?.isConnected; }
    focus() { document.activeElement = this; }
    setCustomValidity(value) { this.validationMessage = value; }
    reportValidity() { return !this.validationMessage && (!this.required || !!this.value); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    querySelectorAll(selector) {
      const nodes = [];
      const visit = element => {
        for (const child of element.children) { if (matches(child, selector)) nodes.push(child); visit(child); }
      };
      visit(this);
      return nodes;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    captureStream() { return new Stream([new Track('video')]); }
    play() { return Promise.resolve(); }
    pause() {}
    setSinkId() { return Promise.resolve(); }
    animate() {
      let resolve, reject;
      let settled = false;
      const animation = {
        finished: new Promise((yes, no) => { resolve = yes; reject = no; }),
        finish() { if (!settled) { settled = true; resolve(); } },
        cancel() { if (!settled) { settled = true; reject(new Error('cancelled')); } }
      };
      animations.push(animation);
      return animation;
    }
  }
  function matches(element, selector) {
    const tag = selector.match(/^[a-z]+/i)?.[0];
    if (tag && element.tagName !== tag.toUpperCase()) return false;
    const id = selector.match(/#([\w-]+)/)?.[1];
    if (id && element.id !== id) return false;
    for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!element.classList.contains(name)) return false;
    for (const [, name, value] of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      if (value !== undefined ? element.getAttribute(name) !== value && element[name] !== value : !element[name] && !(name in element.attrs)) return false;
    }
    return true;
  }
  document = new Element('document');
  const stack = [document];
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const voidTags = new Set(['meta', 'link', 'img', 'input', 'br', 'hr', 'use', 'path', 'stop', 'circle', 'ellipse', 'rect', 'fegaussianblur']);
  for (const token of html.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)) {
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (token.startsWith('<')) {
      const tag = token.match(/^<([\w-]+)/)?.[1];
      if (!tag) continue;
      const element = new Element(tag);
      for (const [, name, value] of token.matchAll(/([\w-]+)="([^"]*)"/g)) {
        element.setAttribute(name, value);
        if (['value', 'min', 'max', 'type', 'name'].includes(name)) element[name] = value;
      }
      element.hidden = /\shidden(?:\s|>)/.test(token);
      element.inert = /\sinert(?:\s|>)/.test(token);
      stack.at(-1).append(element);
      if (!token.endsWith('/>') && !voidTags.has(tag.toLowerCase())) stack.push(element);
    } else {
      const text = new Element('#text'); text.textContent = token;
      stack.at(-1).append(text);
    }
  }
  document.getElementById = id => document.querySelector('#' + id);
  document.createElement = tag => new Element(tag);
  document.createTextNode = value => { const text = new Element('#text'); text.textContent = value; return text; };
  document.body = document.querySelector('body');
  document.activeElement = document.body;
  class Track {
    constructor(kind) { this.kind = kind; this.readyState = 'live'; this.enabled = true; }
    stop() { this.readyState = 'ended'; }
    getSettings() { return { displaySurface: 'browser' }; }
  }
  class Stream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return [...this.tracks]; }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
    addTrack(track) { this.tracks.push(track); }
    removeTrack(track) { this.tracks = this.tracks.filter(item => item !== track); }
  }
  const audioNode = () => ({ connect() {}, disconnect() {}, gain: { value: 1 }, fftSize: 512, frequencyBinCount: 256, getByteTimeDomainData(data) { data.fill(128); } });
  class AudioContext {
    constructor() { this.state = 'running'; }
    createMediaStreamDestination() { return { ...audioNode(), stream: new Stream([new Track('audio')]) }; }
    createMediaStreamSource() { return audioNode(); }
    createGain() { return audioNode(); }
    createAnalyser() { return audioNode(); }
  }
  class Peer {
    constructor() { this.listeners = {}; this.disconnected = false; this.destroyed = false; }
    on(name, listener) { this.listeners[name] = listener; }
    connect() { return { on() {}, send() {}, close() {}, open: true }; }
    call() { return { on() {}, close() {}, answer() {} }; }
  }
  const storage = new Map();
  if (saved !== undefined) storage.set('callzin_profile', saved);
  const media = { microphoneRequests: 0 };
  const context = vm.createContext({
    document, URL, URLSearchParams, console, Peer, AudioContext, MediaStream: Stream,
    HTMLMediaElement: class {}, Audio: function () { return new Element('audio'); },
    location: { href: 'http://localhost/', search: '' },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    navigator: {
      userAgent: 'Desktop test',
      clipboard: { writeText: async () => {} },
      permissions: { query: async () => ({ state: 'prompt' }) },
      mediaDevices: {
        enumerateDevices: async () => [],
        addEventListener() {},
        getUserMedia: async () => { media.microphoneRequests++; return new Stream([new Track('audio')]); },
        getDisplayMedia: async () => new Stream([new Track('video'), new Track('audio')])
      }
    },
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: () => 1,
    window: { addEventListener() {}, AudioContext, matchMedia: () => ({ matches: reducedMotion }), scrollTo() {} }
  });
  for (const filename of ['avatars.js', 'script.js', 'ui.js']) vm.runInContext(fs.readFileSync(path.join(root, filename), 'utf8'), context, { filename });
  const run = code => vm.runInContext(code, context);
  run("initializePeer('test-peer')");
  if (connected) run("peer.listeners.open('test-peer')");
  return { run, document, storage, media, animations };
}

test('old emoji profiles migrate while keeping the existing name and preferences', () => {
  const page = app({ saved: JSON.stringify({ name: 'Ana Silva', avatar: '🐱', outputVolume: 200, screenQuality: 'hd30' }) });
  assert.equal(page.run('profile.avatar'), 'chrome');
  assert.equal(page.run('profile.name'), 'Ana Silva');
  assert.equal(page.run('profile.outputVolume'), 100);
  assert.equal(page.run('profile.screenQuality'), 'hd30');
  assert.equal(page.document.getElementById('homeAvatar').textContent, 'AS');
});

test('a malformed saved profile does not prevent the interface from loading', () => {
  const page = app({ saved: '{broken' });
  assert.equal(page.run('profile.name'), 'Visitante');
  assert.equal(page.document.getElementById('homeName').textContent, 'Visitante');
});

test('profile changes can be cancelled or saved across all profile surfaces', () => {
  const page = app();
  page.run("openProfile(); document.getElementById('profileName').value = 'Ana Silva'; updateProfilePreview(); closeProfile()");
  assert.equal(page.run('profile.name'), 'Visitante');
  page.run("openProfile(); document.getElementById('profileName').value = 'Ana Silva'; draftAvatar = 'carbon'; saveProfileDialog()");
  const saved = JSON.parse(page.storage.get('callzin_profile'));
  assert.equal(saved.name, 'Ana Silva');
  assert.equal(saved.avatar, 'carbon');
  for (const id of ['profileAvatar', 'homeAvatar', 'mobileAvatar', 'settingsAvatar']) {
    assert.equal(page.document.getElementById(id).textContent, 'AS');
    assert.equal(page.document.getElementById(id).dataset.finish, 'carbon');
  }
});

test('untrusted peer avatar markup is replaced with the catalog fallback', () => {
  const page = app();
  page.run("renderAvatar(document.getElementById('homeAvatar'), '<img src=x onerror=alert(1)>', 'Ana Silva')");
  const avatar = page.document.getElementById('homeAvatar');
  assert.equal(avatar.dataset.finish, 'chrome');
  assert.equal(avatar.children.length, 1);
  assert.equal(avatar.children[0].tagName, 'SPAN');
  assert.equal(avatar.textContent, 'AS');
});

test('join accepts IDs and invitation URLs and rejects invalid inputs', () => {
  const page = app();
  assert.equal(page.run("roomIdFromInput(' test-room_1 ')"), 'test-room_1');
  assert.equal(page.run("roomIdFromInput('https://example.com/?room=abc-123&other=value')"), 'abc-123');
  for (const value of ['', 'hello world', 'javascript:alert(1)', 'https://example.com/no-room', 'x'.repeat(129)]) {
    assert.equal(page.run('roomIdFromInput(' + JSON.stringify(value) + ')'), '');
  }
});

test('an invalid invitation never requests microphone access', async () => {
  const page = app();
  await page.run("setEntryMode('join'); document.getElementById('roomId').value = 'invalid room'; submitRoom()");
  assert.equal(page.media.microphoneRequests, 0);
  assert.match(page.document.getElementById('roomId').validationMessage, /ID válido/);
});

test('waiting for signalling does not request microphone access', async () => {
  const page = app({ connected: false });
  await page.run('submitRoom()');
  assert.equal(page.media.microphoneRequests, 0);
  assert.match(page.document.getElementById('status').textContent, /Aguarde/);
  assert.equal(page.document.getElementById('enterRoomBtn').disabled, false);
});

test('navigation keeps only the selected view active and manages settings panels', () => {
  const page = app();
  page.run("setView('settings'); setSettingsTab('appearance')");
  assert.equal(page.document.querySelectorAll('.view.active').length, 1);
  assert.equal(page.document.querySelector('.view.active').id, 'view-settings');
  assert.equal(page.document.getElementById('view-home').inert, true);
  assert.equal(page.document.getElementById('settings-audio').hidden, true);
  assert.equal(page.document.getElementById('settings-appearance').hidden, false);
  assert.equal(page.document.getElementById('tab-appearance').getAttribute('aria-selected'), 'true');
});

test('participant count updates preserve the live connection badge', () => {
  const page = app();
  page.run("participants.set('friend', {}); updateParticipantCount()");
  assert.equal(page.document.getElementById('roomCount').textContent, '2 pessoas na sala');
  assert.equal(page.document.getElementById('connDot').isConnected, true);
  assert.equal(page.document.getElementById('connText').isConnected, true);
});

test('leaving and creating another room rebuilds live audio and resets controls', async () => {
  const page = app();
  await page.run('enterRoom()');
  const firstTrack = page.run('sentAudioTrack');
  const rawTrack = page.run('rawMicStream.getAudioTracks()[0]');
  page.run('toggleMic(); toggleDeafen()');
  assert.equal(page.document.getElementById('micBtn').getAttribute('aria-pressed'), 'true');
  page.run('leaveRoom()');
  assert.equal(firstTrack.readyState, 'ended');
  assert.equal(rawTrack.readyState, 'ended');
  assert.equal(page.run('mixDestNode'), null);
  assert.equal(page.run('inRoom'), false);
  assert.equal(page.document.getElementById('roomStage').hidden, true);
  await page.run('enterRoom()');
  assert.notEqual(page.run('sentAudioTrack'), firstTrack);
  assert.equal(page.run('sentAudioTrack.readyState'), 'live');
  assert.equal(page.run('micOn'), true);
  assert.equal(page.run('deafened'), false);
  assert.equal(page.document.getElementById('micBtn').getAttribute('aria-pressed'), 'false');
  assert.equal(page.media.microphoneRequests, 2);
});

test('a late screen-share stop after leaving is harmless', async () => {
  const page = app();
  await page.run('enterRoom()');
  await page.run('toggleScreen()');
  assert.equal(page.run('mySharing'), true);
  page.run('leaveRoom(); stopScreenShare()');
  assert.equal(page.run('mySharing'), false);
  assert.equal(page.run('localStream'), null);
});

test('rapid navigation cannot reveal a stale outgoing view', async () => {
  const page = app({ reducedMotion: false });
  page.run("setView('settings'); setView('room'); setView('home')");
  page.animations.forEach(animation => animation.finish());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(page.document.querySelector('.view.active').id, 'view-home');
  assert.equal(page.document.querySelectorAll('.view.active').length, 1);
});
