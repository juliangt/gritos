/**
 * Ambient declarations for the Node built-ins that read files from disk.
 * The app tsconfig ships no Node types (`types: []`) and the project
 * deliberately avoids adding @types/node to the whole tree, so the few
 * functions the suite actually needs are declared here with the narrowest
 * possible surface (module augmentation in a test file would fail: the
 * module names do not resolve without @types/node).
 *
 * Only buildOutput.test.ts uses this, for its issue #104 dist/ assertions:
 * the manifest and icon PNGs are public assets that Vite copies to dist/
 * verbatim, so unlike the in-memory rollup output they can only be
 * asserted from disk after a real build.
 */
declare module 'node:fs/promises' {
  export function readFile(path: URL | string): Promise<Uint8Array>
}
