const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const Identity = require('../identity.js');
const Model = require('../social-model.js');
function memory() { const data = new Map(); return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) }; }
const a = 'nx-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const b = 'nx-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('identity remains stable when wrapping the same stored keys', async () => {
  const first = await Identity.create(webcrypto);
  const again = await Identity.wrap(first.pair, webcrypto);
  assert.match(first.id, /^nx-[a-f0-9]{32}$/);
  assert.equal(again.id, first.id);
  assert.equal(first.pair.privateKey.extractable, false);
});

test('peer authentication rejects copied IDs and modified challenges', async () => {
  const alice = await Identity.create(webcrypto);
  const bob = await Identity.create(webcrypto);
  const challenge = 'nexus:alice:bob:fresh-random-challenge';
  const signature = await alice.sign(challenge);
  assert.equal(await Identity.verify(alice.id, alice.publicJwk, challenge, signature, webcrypto), true);
  assert.equal(await Identity.verify(bob.id, alice.publicJwk, challenge, signature, webcrypto), false);
  assert.equal(await Identity.verify(alice.id, alice.publicJwk, challenge + '-changed', signature, webcrypto), false);
  assert.equal(await Identity.verify(alice.id, alice.publicJwk, challenge, 'broken', webcrypto), false);
});

test('friend status and history survive a new store instance', () => {
  const storage = memory(); const first = new Model.Store(storage);
  first.setContact(b, 'incoming', { name: 'Bia', avatar: 'carbon' });
  first.setContact(b, 'accepted');
  first.putMessage('dm:' + b, { id: 'message-1', author: b, name: 'Bia', text: 'Oi!', createdAt: Date.now() });
  const again = new Model.Store(storage);
  assert.equal(again.accepted(b), true);
  assert.equal(again.contact(b).name, 'Bia');
  assert.equal(again.messages('dm:' + b)[0].text, 'Oi!');
});

test('queued messages are idempotent and removed only after acknowledgment', () => {
  const storage = memory(); const store = new Model.Store(storage);
  store.queue(b, 'dm-message', { text: 'Olá' }, 'message-1');
  store.queue(b, 'dm-message', { text: 'Olá' }, 'message-1');
  assert.equal(store.state.outbox.length, 1);
  const again = new Model.Store(storage);
  assert.equal(again.state.outbox[0].id, 'message-1');
  again.acknowledge('unknown');
  assert.equal(again.state.outbox.length, 1);
  again.acknowledge('message-1');
  assert.equal(again.state.outbox.length, 0);
});

test('an older or forged edit cannot replace a message from another author', () => {
  const store = new Model.Store(memory()); const key = 'dm:' + b;
  store.putMessage(key, { id: 'm1', author: a, text: 'Original', revision: 0 });
  store.putMessage(key, { id: 'm1', author: a, text: 'Editada', revision: 2 });
  assert.equal(store.putMessage(key, { id: 'm1', author: a, text: 'Antiga', revision: 1 }), false);
  assert.equal(store.putMessage(key, { id: 'm1', author: b, text: 'Forjada', revision: 3 }), false);
  assert.equal(store.messages(key)[0].text, 'Editada');
});

test('read markers count only unread messages from other people', () => {
  const store = new Model.Store(memory()); const key = 'dm:' + b; const now = Date.now();
  store.putMessage(key, { id: 'm1', author: a, text: 'Minha', createdAt: now - 30 });
  store.putMessage(key, { id: 'm2', author: b, text: 'Recebida', createdAt: now - 20 });
  store.putMessage(key, { id: 'm3', author: b, text: 'Mais uma', createdAt: now - 10 });
  assert.equal(store.unread(key, a), 2);
  store.markRead(key, now - 15);
  assert.equal(store.unread(key, a), 1);
  store.markRead(key, now);
  assert.equal(store.unread(key, a), 0);
});

test('spaces start with independent text and voice channels and retain their names', () => {
  const storage = memory(); const store = new Model.Store(storage);
  const room = store.createSpace(a, { name: 'Ana' }, 'Noite de jogo');
  assert.equal(room.name, 'Noite de jogo');
  assert.equal(room.channels.filter(channel => channel.type === 'text').length, 1);
  assert.equal(room.channels.filter(channel => channel.type === 'voice').length, 1);
  const updated = store.updateSpace(room.id, a, draft => {
    draft.name = 'Estúdio';
    draft.channels.push({ id: Model.uid(), name: 'música', type: 'voice' });
  });
  assert.equal(updated.revision, 2);
  assert.equal(new Model.Store(storage).state.spaces[room.id].name, 'Estúdio');
  assert.throws(() => store.updateSpace(room.id, b, draft => { draft.name = 'Intruso'; }), /Só quem criou/);
});

test('a stale room snapshot and changed owner cannot overwrite a local room', () => {
  const store = new Model.Store(memory()); const room = store.createSpace(a, { name: 'Ana' }, 'Sala');
  const before = Model.clone(room);
  store.updateSpace(room.id, a, draft => { draft.name = 'Sala atual'; });
  assert.equal(store.upsertSpace(before), false);
  assert.equal(store.upsertSpace({ ...before, owner: b, revision: 99 }), false);
  assert.equal(store.state.spaces[room.id].name, 'Sala atual');
});

test('room invites and friend links preserve IDs and reject unsafe schemes', () => {
  const room = new Model.Store(memory()).createSpace(a, { name: 'Ana' }, 'Sala');
  const link = Model.inviteLink('https://example.com/?old=1#hash', room);
  assert.deepEqual(Model.parseInvite(link), { owner: a, space: room.id, token: room.invite.token });
  assert.equal(Model.parseContact(Model.contactLink('https://example.com/', b)), b);
  assert.equal(Model.parseContact(b), b);
  assert.equal(Model.parseContact('javascript:alert(1)'), null);
  assert.equal(Model.parseInvite('https://example.com/?host=x&space=y&invite=bad'), null);
});

test('failed storage does not discard a previously saved state', () => {
  const storage = memory(); const store = new Model.Store(storage);
  store.setContact(b, 'accepted', { name: 'Bia' });
  storage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => store.setContact(b, 'blocked'));
  assert.equal(store.contact(b).state, 'accepted');
});

test('malformed snapshots cannot insert prototype keys or duplicate channels', () => {
  assert.equal(Model.validId('__proto__'), false);
  assert.equal(Model.validId('constructor'), false);
  assert.equal(Model.normalizeSpace({ id: 'space1', owner: a, channels: [{ id: 'same', type: 'text' }, { id: 'same', type: 'voice' }] }), null);
  assert.equal(Model.normalizeMessage({ id: 'bad', author: 'constructor', text: 'bad' }), null);
});
