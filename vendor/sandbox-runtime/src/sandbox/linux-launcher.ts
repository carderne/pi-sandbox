import { createHash } from 'node:crypto'
import { accessSync, constants, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Pure artifact validation, also exercised with isolated test fixtures. */
export function validateLinuxLauncher(
  path: string,
  sources: URL[],
  arch: string,
): boolean {
  try {
    accessSync(path, constants.R_OK | constants.X_OK)
    const metadata = JSON.parse(readFileSync(`${path}.build.json`, 'utf8'))
    const sourceHash = createHash('sha256')
    for (const file of sources) sourceHash.update(readFileSync(file))
    return (
      metadata.arch === arch &&
      metadata.sourceSha256 === sourceHash.digest('hex') &&
      metadata.binarySha256 ===
        createHash('sha256').update(readFileSync(path)).digest('hex')
    )
  } catch {
    return false
  }
}

/** Only our native launcher is valid. Never search PATH, npm roots, or argv0. */
export function getLinuxLauncherPath(): string | null {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
    return null
  }
  const path = fileURLToPath(
    new URL(`../../vendor/seccomp/${process.arch}/sandbox-launcher`, import.meta.url),
  )
  const sources = ['launcher.c', 'relay.h'].map(file =>
    new URL(`../../../linux-launcher/${file}`, import.meta.url),
  )
  return validateLinuxLauncher(path, sources, process.arch) ? path : null
}

export function requireLinuxLauncher(): string {
  const path = getLinuxLauncherPath()
  if (!path) {
    throw new Error(
      'Capability-free sandbox launcher missing or stale. Run `corepack pnpm build:sandbox` ' +
      'in pi-sandbox-fix; refusing to run without Unix-socket protection.',
    )
  }
  return path
}
