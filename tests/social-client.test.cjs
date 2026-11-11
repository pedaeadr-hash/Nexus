const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Identity = require('../identity.js');
const M = require('../social-model.js');
const { Client } = require('../social-client.js');

function memory() { const data = new Map(); return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) }; }
async function until(predicate, label = 'state update') {
  const deadline = Date.now() + 2500;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 3)); }
}
class Connection extends EventEmitter {
  constructor(peer, label) { super(); this.peer = peer; this.label = label; this.open = false; this.closed = false; }
  send(frame) { if (!this.open || this.closed) throw new Error('closed'); const payload = structuredClone(frame); queueMicrotask(() => { if (!this.other.closed) this.other.emit('data', payload); }); }
  close() { if (this.closed) return; this.closed = true; this.open = false; this.emit('close'); if (this.other && !this.other.closed) { this.other.closed = true; this.other.open = false; this.other.emit('close'); } }
}
class Network {
  constructor() { this.clients = new Map(); }
  online(client) {
    this.clients.set(client.id, client);
    client.attachPeer({ id: client.id, open: true, connect: (id, options) => {
      const local = new Connection(id, options.label); const remote = new Connection(client.id, options.label); local.other = remote; remote.other = local;
      queueMicrotask(() => {
        const recipient = this.clients.get(id);
        if (!recipient) { local.emit('error', new Error('offline')); local.close(); return; }
        recipient.acceptConnection(remote);
        if (local.closed || remote.closed) return;
        local.open = remote.open = true; remote.emit('open'); local.emit('open');
      });
      return local;
    } });
  }
  offline(client) { this.clients.delete(client.id); client.offline(); for (const record of [...client.links.values()]) record.connection.close(); }
}
async function setup(names = ['Ana', 'Bia', 'Caio']) {
  const network = new Network(); const people = [];
  for (const name of names) {
    const identity = await Identity.create(); const storage = memory();
    const store = new M.Store(storage); const person = { name, avatar: 'chrome' };
    const client = new Client({ store, identity, person: () => person, autoReconnect: false, connectionTimeout: 500 });
    const events = []; client.on(event => events.push(event));
    const entry = { identity, storage, store, person, client, events, id: identity.id };
    people.push(entry); network.online(client);
  }
  return { network, people, destroy: () => people.forEach(person => person.client.destroy()) };
}
async function friends(a, b) {
  a.client.requestFriend(b.id);
  await until(() => b.store.contact(a.id)?.state === 'incoming', 'friend request');
  b.client.acceptFriend(a.id);
  await until(() => a.store.accepted(b.id) && b.store.accepted(a.id), 'friend acceptance');
}
async function join(owner, guest, space) {
  await guest.client.joinInvite(M.inviteLink('https://nexus.test/', space));
  await until(() => guest.store.state.spaces[space.id]?.members[guest.id], 'space membership');
}

test('two verified peers exchange friend requests, DMs, delivery and read receipts', async t => {
  const env = await setup(); t.after(env.destroy); const [a, b] = env.people;
  await friends(a, b);
  const message = a.client.sendDM(b.id, 'Oi, Bia!');
  await until(() => b.store.messages('dm:' + a.id).length === 1, 'DM delivery');
  assert.equal(b.store.messages('dm:' + a.id)[0].text, 'Oi, Bia!');
  await until(() => a.store.messages('dm:' + b.id)[0].status === 'delivered', 'delivery receipt');
  b.client.readDM(a.id);
  await until(() => a.store.messages('dm:' + b.id)[0].status === 'read', 'read receipt');
  a.client.editMessage('dm:' + b.id, message.id, 'Olá, Bia!');
  await until(() => b.store.messages('dm:' + a.id)[0].text === 'Olá, Bia!', 'message edit');
  a.client.editMessage('dm:' + b.id, message.id, '', true);
  await until(() => b.store.messages('dm:' + a.id)[0].deleted, 'message deletion');
});

test('a queued offline DM is delivered after both clients restart with the same identity', async t => {
  const env = await setup(['Ana', 'Bia']); t.after(env.destroy); const [a, b] = env.people;
  await friends(a, b); await until(() => !a.store.state.outbox.length && !b.store.state.outbox.length);
  env.network.offline(b.client); b.client.destroy();
  const message = a.client.sendDM(b.id, 'Fica para quando você voltar.');
  assert.equal(a.store.messages('dm:' + b.id).find(item => item.id === message.id).status, 'queued');
  env.network.offline(a.client); a.client.destroy();
  for (const person of [a, b]) { person.store = new M.Store(person.storage); person.client = new Client({ store: person.store, identity: person.identity, person: () => person.person, autoReconnect: false, connectionTimeout: 500 }); env.network.online(person.client); }
  await until(() => b.store.messages('dm:' + a.id).some(item => item.id === message.id), 'offline DM retry');
  await until(() => a.store.state.outbox.length === 0, 'queue acknowledgement');
  assert.equal(b.store.messages('dm:' + a.id).filter(item => item.id === message.id).length, 1);
});

test('room invitations, named channels and group chat synchronize across three peers', async t => {
  const env = await setup(); t.after(env.destroy); const [a, b, c] = env.people;
  const space = a.client.createSpace('Noite de jogo');
  await join(a, b, space); await join(a, c, space);
  const channel = a.client.addChannel(space.id, 'estratégia', 'text');
  await until(() => b.store.state.spaces[space.id].channels.some(item => item.id === channel.id) && c.store.state.spaces[space.id].channels.some(item => item.id === channel.id));
  a.client.configureSpace(space.id, { name: 'Clube Nexus', topic: 'Nosso grupo' });
  await until(() => c.store.state.spaces[space.id].name === 'Clube Nexus');
  const message = b.client.sendSpaceMessage(space.id, channel.id, 'Todo mundo pronto?');
  const key = 'space:' + space.id + ':' + channel.id;
  await until(() => a.store.messages(key).length && c.store.messages(key).length, 'group delivery');
  assert.equal(c.store.messages(key)[0].author, b.id);
  assert.equal(c.store.messages(key)[0].name, 'Bia');
  assert.equal(c.store.messages('space:' + space.id + ':' + space.channels[0].id).length, 0);
  await until(() => b.store.messages(key)[0].status === 'delivered');
  b.client.editMessage(key, message.id, 'Agora sim!');
  await until(() => c.store.messages(key)[0].text === 'Agora sim!');
  assert.throws(() => b.client.configureSpace(space.id, { name: 'Intruso' }), /Só quem criou/);
});

test('voice rosters isolate channels and clear disconnected members', async t => {
  const env = await setup(); t.after(env.destroy); const [a, b, c] = env.people;
  const space = a.client.createSpace('Estúdio'); await join(a, b, space); await join(a, c, space);
  const v1 = space.channels.find(channel => channel.type === 'voice').id;
  const v2 = a.client.addChannel(space.id, 'Outro papo', 'voice').id;
  await until(() => c.store.state.spaces[space.id].channels.some(channel => channel.id === v2));
  a.client.joinVoice(space.id, v1); b.client.joinVoice(space.id, v1); c.client.joinVoice(space.id, v2);
  await until(() => a.client.voiceTargets().includes(b.id) && b.client.voiceTargets().includes(a.id));
  assert.deepEqual(a.client.voiceTargets(), [b.id]);
  assert.deepEqual(c.client.voiceTargets(), []);
  assert.equal(a.client.mediaAllowed(c.id, { nexusVoice: 1, session: a.client.voice.session }), false);
  assert.equal(a.client.mediaAllowed(b.id, { nexusVoice: 1, session: 'wrong-session' }), false);
  assert.equal(a.client.mediaAllowed(b.id, { nexusVoice: 1, session: a.client.voice.session }), true);
  env.network.offline(b.client);
  await until(() => !a.client.voiceTargets().includes(b.id));
  assert.equal(a.client.roomRoster(space.id).some(member => member.id === b.id), false);
});

test('a private call requires explicit acceptance and ends on both peers', async t => {
  const env = await setup(); t.after(env.destroy); const [a, b, c] = env.people;
  await friends(a, b);
  const call = await a.client.startCall(b.id);
  await until(() => b.client.pendingCall?.id === call.id);
  assert.equal(b.client.voice, null);
  assert.equal(a.client.voice, null);
  b.client.acceptCall();
  await until(() => a.client.voice?.session === call.id);
  assert.equal(a.client.initiatesMedia(b.id), true);
  assert.equal(b.client.initiatesMedia(a.id), false);
  assert.equal(b.client.mediaAllowed(a.id, { nexusVoice: 1, session: call.id }), true);
  assert.equal(b.client.mediaAllowed(c.id, { nexusVoice: 1, session: call.id }), false);
  a.client.endCall();
  await until(() => b.client.voice === null);
  assert.equal(a.client.voice, null);
});

test('do-not-disturb refuses a private call without opening an incoming prompt', async t => {
  const env = await setup(['Ana', 'Bia']); t.after(env.destroy); const [a, b] = env.people;
  await friends(a, b); b.store.state.preferences.presence = 'busy';
  await a.client.startCall(b.id);
  await until(() => a.events.some(event => event.type === 'call-ended' && event.reason === 'busy'));
  assert.equal(b.client.pendingCall, null);
  assert.equal(b.events.some(event => event.type === 'incoming-call'), false);
});

test('a renewed invitation rejects new guests and an owner can pin messages', async t => {
  const env = await setup(); t.after(env.destroy); const [a, b, c] = env.people;
  const space = a.client.createSpace('Sala'); const oldLink = M.inviteLink('https://nexus.test/', space);
  await join(a, b, space);
  a.client.renewInvite(space.id);
  await assert.rejects(c.client.joinInvite(oldLink), /renovado|expirou/);
  const channel = space.channels.find(item => item.type === 'text').id;
  const message = b.client.sendSpaceMessage(space.id, channel, 'Fixar esta informação.');
  const key = 'space:' + space.id + ':' + channel;
  await until(() => a.store.messages(key).length);
  assert.throws(() => b.client.pin(space.id, channel, message.id), /Só o anfitrião/);
  a.client.pin(space.id, channel, message.id);
  await until(() => b.store.messages(key)[0].pinned);
});

test('block prevents connections and preserves the local history', async t => {
  const env = await setup(['Ana', 'Bia']); t.after(env.destroy); const [a, b] = env.people;
  await friends(a, b); a.client.sendDM(b.id, 'Antes do bloqueio');
  await until(() => b.store.messages('dm:' + a.id).length);
  b.client.block(a.id);
  assert.equal(b.store.blocked(a.id), true);
  assert.equal(b.store.messages('dm:' + a.id).length, 1);
  assert.equal(await a.client.connect(b.id, true), false);
  assert.throws(() => b.client.sendDM(a.id, 'Depois'), /amigos/);
  b.client.unblock(a.id); assert.equal(b.store.contact(a.id).state, 'removed');
});

test('a forged message author cannot overwrite the other person’s message', async t => {
  const env = await setup(['Ana', 'Bia']); t.after(env.destroy); const [a, b] = env.people;
  await friends(a, b);
  const message = a.client.sendDM(b.id, 'Original da Ana');
  await until(() => b.store.messages('dm:' + a.id).length);
  b.client.send(a.id, 'dm-message', { ...message, author: a.id, text: 'Falsa', revision: 99 });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(a.store.messages('dm:' + b.id)[0].text, 'Original da Ana');
});

test('simultaneous friend requests converge on one authenticated connection', async t => {
  const env = await setup(['Ana', 'Bia']); t.after(env.destroy); const [a, b] = env.people;
  a.client.requestFriend(b.id); b.client.requestFriend(a.id);
  await until(() => a.store.accepted(b.id) && b.store.accepted(a.id), 'simultaneous friendship');
  assert.equal(a.client.links.size, 1); assert.equal(b.client.links.size, 1);
  a.client.sendDM(b.id, 'Sem conexão duplicada.');
  await until(() => b.store.messages('dm:' + a.id).length === 1);
});

test('history pagination includes messages from a member who has left', async t => {
  const env = await setup(); t.after(env.destroy); const [a, b, c] = env.people;
  const space = a.client.createSpace('Sala'); await join(a, b, space);
  const channel = space.channels.find(item => item.type === 'text').id;
  b.client.sendSpaceMessage(space.id, channel, 'Minha contribuição.');
  const key = 'space:' + space.id + ':' + channel;
  await until(() => a.store.messages(key).length === 1);
  b.client.leaveSpace(space.id); await until(() => !a.store.state.spaces[space.id].members[b.id]);
  await join(a, c, a.store.state.spaces[space.id]);
  await until(() => c.store.messages(key).length === 1);
  assert.equal(c.store.messages(key)[0].name, 'Bia');
});

test('a member returning after the host closed a space removes the stale membership', async t => {
  const env = await setup(['Ana', 'Bia']); t.after(env.destroy); const [a, b] = env.people;
  const space = a.client.createSpace('Temporário'); await join(a, b, space);
  env.network.offline(b.client); b.client.destroy();
  a.client.closeSpace(space.id);
  assert.ok(b.store.state.spaces[space.id]);
  b.client = new Client({ store: b.store, identity: b.identity, person: () => b.person, autoReconnect: false, connectionTimeout: 500 });
  env.network.online(b.client);
  await until(() => !b.store.state.spaces[space.id], 'closed space cleanup');
  assert.equal(b.client.voice, null);
});
