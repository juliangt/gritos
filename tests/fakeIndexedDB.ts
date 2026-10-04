import { vi } from 'vitest'

/**
 * Minimal in-memory IndexedDB stub (issue #24): neither jsdom nor the node
 * test environment ships an implementation, and the key vault needs one to
 * exercise the real wrap/unwrap path. Implements just enough of the API
 * surface used by src/lib/crypto/keyVault.ts — `open` (with the
 * upgrade event), a single object store per database with get/put/clear,
 * and request objects delivered on a microtask. No keys, indexes, versions
 * or error events beyond request failure.
 */

export interface FakeIndexedDBHandle {
  /** database → store → record, exposed for assertions. */
  databases: Map<string, Map<string, Map<string, unknown>>>
}

export interface FakeIndexedDBOptions {
  /** When set, the `open` request fails with this error instead of opening. */
  openError?: DOMException
}

/**
 * Mutable state of a fake request. The real IDBRequest type declares its
 * fields readonly (and its handlers over `Event`), so the stub keeps a
 * plain internal shape and casts once at the boundary.
 */
interface FakeRequestState<T> {
  result: T
  error: DOMException | null
  onsuccess: ((request: IDBRequest<T>) => void) | null
  onerror: ((request: IDBRequest<T>) => void) | null
  onupgradeneeded: ((request: IDBRequest<T>) => void) | null
  onblocked: ((request: IDBRequest<T>) => void) | null
}

/** Settles a fake request on a microtask, mimicking real IDB event timing. */
function makeRequest<T>(
  work: () => T,
  beforeSuccess?: (request: FakeRequestState<T>) => void,
): IDBRequest<T> {
  const state: FakeRequestState<T> = {
    result: undefined as unknown as T,
    error: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
    onblocked: null,
  }
  queueMicrotask(() => {
    try {
      state.result = work()
      beforeSuccess?.(state)
      state.onsuccess?.(state as unknown as IDBRequest<T>)
    } catch (error) {
      state.error = error as DOMException
      state.onerror?.(state as unknown as IDBRequest<T>)
    }
  })
  return state as unknown as IDBRequest<T>
}

function createDatabase(stores: Map<string, Map<string, unknown>>): IDBDatabase {
  return {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => {
      stores.set(name, new Map())
    },
    close: () => {},
    transaction: (_name: string, _mode?: IDBTransactionMode) => {
      const contents = stores.get(_name)
      if (contents === undefined) {
        throw new Error(`fakeIndexedDB: unknown object store «${_name}»`)
      }
      return {
        objectStore: () => ({
          get: (key: string) => makeRequest(() => contents.get(key)),
          put: (value: unknown, key: string) =>
            makeRequest(() => {
              contents.set(key, value)
              return key
            }),
          clear: () =>
            makeRequest(() => {
              contents.clear()
              return undefined
            }),
        }),
      }
    },
  } as unknown as IDBDatabase
}

/** Installs the stub as the global `indexedDB`. Returns the backing data. */
export function installFakeIndexedDB(
  options: FakeIndexedDBOptions = {},
): FakeIndexedDBHandle {
  const databases: FakeIndexedDBHandle['databases'] = new Map()
  vi.stubGlobal('indexedDB', {
    open: (name: string) => {
      if (options.openError !== undefined) {
        return makeRequest<IDBDatabase>(() => {
          throw options.openError as DOMException
        })
      }
      let stores = databases.get(name)
      const isNew = stores === undefined
      if (isNew) {
        stores = new Map()
        databases.set(name, stores)
      }
      return makeRequest(
        () => createDatabase(stores as Map<string, Map<string, unknown>>),
        (request) => {
          // Fresh database: the upgrade event fires before success, with
          // the database already reachable through request.result.
          if (isNew) {
            request.onupgradeneeded?.(request as unknown as IDBRequest<IDBDatabase>)
          }
        },
      )
    },
  })
  return { databases }
}
