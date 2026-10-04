import { describe, expect, it } from 'vitest'
import licenseText from '../LICENSE?raw'
import packageJsonRaw from '../package.json?raw'

/**
 * Release guard for issue #39 (the repo was tagged v1.0.0 without any
 * license, so default copyright applied and nobody could legally reuse the
 * code). Keeps the license from silently regressing:
 *
 *  1. `package.json` carries the `MIT` SPDX identifier, and
 *  2. the repo-root `LICENSE` file is the MIT text naming the copyright
 *     holder.
 *
 * Both files are read through vite's `?raw` transform (no `node:fs` — the
 * project deliberately ships no Node types), so the assertions run against
 * the exact bytes on disk.
 */
const packageJson = JSON.parse(packageJsonRaw) as { license?: string }

describe('license metadata (issue #39)', () => {
  it('declares the MIT SPDX identifier in package.json', () => {
    expect(packageJson.license).toBe('MIT')
  })

  it('ships the MIT License text naming the copyright holder at the repo root', () => {
    expect(licenseText).toContain('MIT License')
    expect(licenseText).toContain('Copyright (c) 2026 Julián Garcia Tuñón')
    expect(licenseText).toContain('Permission is hereby granted, free of charge')
  })
})
