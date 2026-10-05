'use strict';
/**
 * In-memory stand-in for the window.storage get/set/delete/list contract, matching the real
 * IndexedDB polyfill: get() REJECTS with Error('not-found') for a missing key, set()/delete()
 * resolve null on failure. Supports fault injection and records every call.
 */
function createMemoryStorage(opts) {
  const o = opts || {};
  const data = new Map();
  const calls = { get: [], set: [], delete: [], list: [] };
  const api = {
    data, calls,
    failGet: o.failGet || null,     // (key) => Error|undefined
    failSet: o.failSet || null,     // (key, value) => boolean
    failList: !!o.failList,
    setDelay: o.setDelay || null,   // (key, value) => ms
    get(key) {
      calls.get.push(key);
      if (api.failGet) { const e = api.failGet(key); if (e) return Promise.reject(e); }
      if (!data.has(key)) return Promise.reject(new Error('not-found'));
      return Promise.resolve({ key, value: data.get(key), shared: false });
    },
    set(key, value) {
      calls.set.push({ key, bytes: String(value).length });
      const ms = api.setDelay ? api.setDelay(key, value) : 0;
      const run = () => {
        if (api.failSet && api.failSet(key, value)) return null;
        data.set(key, value);
        return { key, value, shared: false };
      };
      return ms ? new Promise((res) => setTimeout(() => res(run()), ms)) : Promise.resolve(run());
    },
    delete(key) {
      calls.delete.push(key);
      const had = data.delete(key);
      return Promise.resolve({ key, deleted: had, shared: false });
    },
    list(prefix) {
      calls.list.push(prefix);
      if (api.failList) return Promise.resolve(null);
      return Promise.resolve({ keys: [...data.keys()].filter((k) => k.startsWith(prefix || '')), prefix, shared: false });
    }
  };
  return api;
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.getOwnPropertyNames(o).forEach((k) => deepFreeze(o[k]));
  }
  return o;
}

module.exports = { createMemoryStorage, deepFreeze };
