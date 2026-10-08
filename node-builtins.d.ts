/**
 * Ambient declarations for the Node built-ins the build pipeline and its
 * tests need. The project ships no Node types (`types: []` in both
 * tsconfigs) and deliberately avoids adding @types/node, so exactly the
 * narrow surface used by gritosSwManifest() in vite.config.ts and by
 * tests/buildOutput.test.ts is declared here:
 *
 *   - node:fs/promises — reading public/sw.js (as text, for the build-time
 *     placeholder rewrite) and the static public assets (as bytes, for the
 *     cache-version digest), plus the dist/ assertions (bytes + a recursive
 *     readdir);
 *   - node:crypto — the sha256 content digest behind the cache version.
 *
 * This file is included by BOTH tsconfigs on purpose: the app project
 * typechecks vite.config.ts too (tests/buildOutput.test.ts imports it), so
 * the declarations must be visible to both programs, not only to the node
 * one. Module augmentation inside a .ts file would not work: the module
 * names do not even resolve without @types/node.
 */

declare module 'node:fs/promises' {
  export function readFile(path: URL | string): Promise<Uint8Array>
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function readdir(
    path: URL | string,
    options: { recursive: true; withFileTypes: true },
  ): Promise<{ name: string; parentPath: string; isFile(): boolean }[]>
}

declare module 'node:crypto' {
  interface Hash {
    update(data: string | Uint8Array): Hash
    digest(encoding: 'hex'): string
  }
  export function createHash(algorithm: 'sha256'): Hash
}
