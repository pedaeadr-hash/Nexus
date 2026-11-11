(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NexusIdentity = api;
})(globalThis, function () {
  'use strict';
  const encoder = new TextEncoder();
  const publicCache = new Map();
  const base64 = bytes => {
    let value = '';
    for (const byte of new Uint8Array(bytes)) value += String.fromCharCode(byte);
    return btoa(value);
  };
  const unbase64 = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));

  async function fingerprint(publicKey, cryptoProvider = globalThis.crypto) {
    const bytes = await cryptoProvider.subtle.exportKey('raw', publicKey);
    const hash = await cryptoProvider.subtle.digest('SHA-256', bytes);
    return 'nx-' + Array.from(new Uint8Array(hash).slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function create(cryptoProvider = globalThis.crypto) {
    if (!cryptoProvider?.subtle) throw new Error('Use HTTPS ou localhost para criar seu perfil.');
    const pair = await cryptoProvider.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    return wrap(pair, cryptoProvider);
  }

  async function wrap(pair, cryptoProvider = globalThis.crypto) {
    const id = await fingerprint(pair.publicKey, cryptoProvider);
    const publicJwk = await cryptoProvider.subtle.exportKey('jwk', pair.publicKey);
    return {
      id, pair, publicJwk,
      async sign(value) {
        return base64(await cryptoProvider.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, encoder.encode(value)));
      }
    };
  }

  async function verify(id, jwk, value, signature, cryptoProvider = globalThis.crypto) {
    try {
      if (!/^nx-[a-f0-9]{32}$/.test(id) || typeof signature !== 'string' || signature.length > 200) return false;
      if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return false;
      if (jwk.x.length > 100 || jwk.y.length > 100) return false;
      const cacheId = id + ':' + jwk.x + ':' + jwk.y;
      let publicKey = publicCache.get(cacheId);
      if (!publicKey) {
        publicKey = await cryptoProvider.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
        if (await fingerprint(publicKey, cryptoProvider) !== id) return false;
        if (publicCache.size > 512) publicCache.clear();
        publicCache.set(cacheId, publicKey);
      }
      return cryptoProvider.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, unbase64(signature), encoder.encode(value));
    } catch (_) { return false; }
  }

  async function open() {
    if (!globalThis.indexedDB) throw new Error('O armazenamento de perfis não está disponível neste navegador.');
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('nexus_identity_v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = () => new Promise((resolve, reject) => {
      const request = db.transaction('keys').objectStore('keys').get('primary');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const load = async () => {
      let pair = await read();
      if (!pair) {
        const identity = await create();
        pair = identity.pair;
        await new Promise((resolve, reject) => {
          const transaction = db.transaction('keys', 'readwrite');
          transaction.objectStore('keys').put(pair, 'primary');
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error);
        });
      }
      return wrap(pair);
    };
    try {
      return globalThis.navigator?.locks ? await navigator.locks.request('nexus-create-identity', load) : await load();
    } finally { db.close(); }
  }

  return { create, wrap, verify, fingerprint, open };
});
