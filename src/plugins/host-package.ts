import { createRequire } from 'node:module'

/**
 * How a built-in host adapter loads the package that states its tables.
 *
 * Each adapter reads its host's own statement -- gea's `host-shims` and
 * `cpp-ir`, Apple's SDK fixture and plugin, the ANGLE plugin -- by package
 * name, which resolves from THIS compiler's `node_modules`. That copy and the
 * checkout a build names with `--plugin <path>` are two spellings of one
 * package, and they drift: the compiler's is an `npm pack` snapshot, the path
 * the build passes is the sibling checkout. A table added to the checkout then
 * never reached a compile that named the checkout explicitly, and the failure
 * surfaced far downstream with nothing saying why (an ambient-type
 * realization stated by the checkout fell through to another host's by-name
 * protocols; an absent global stated by the checkout stayed live and emitted
 * lib.dom's whole `Window`).
 *
 * The stated path is the authority. When `plugins/load.ts` answers a legacy
 * package entry with its built-in adapter, the adapter ADOPTS that file:
 * every later load resolves from the file's own package first -- a package
 * self-reference through its `exports`, or its own dependencies -- and falls
 * back to the compiler's copy only for a specifier the stated package cannot
 * see at all (Apple's SDK is a peer the plugin package does not carry).
 * `MODULE_NOT_FOUND` is the only failure the fallback absorbs: a package that
 * resolves and then fails to load is a defect wherever it lives, and the
 * adapters' own two-failures rule (`gea/host.ts`) still tells it apart.
 *
 * Adoption must precede every read. An adapter table computed at module
 * initialization would freeze the compiler's copy before the CLI ever saw
 * `--plugin`, so the adapters read their tables lazily and `adopt` resets
 * whatever they cached.
 */
export interface HostPackageLoader {
  readonly load: (specifier: string) => unknown
  readonly resolve: (specifier: string) => string
  /** Resolve from this file's package first; the caller resets its own caches. */
  readonly adopt: (file: string) => void
}

const absent = (error: unknown): boolean => (error as { code?: string }).code === 'MODULE_NOT_FOUND'

export const createHostPackageLoader = (ownUrl: string): HostPackageLoader => {
  const own = createRequire(ownUrl)
  let adopted: NodeJS.Require | null = null
  const attempt = <T>(run: (base: NodeJS.Require) => T): T => {
    const bases = adopted === null ? [own] : [adopted, own]
    let missing: unknown = null
    for (const base of bases) {
      try {
        return run(base)
      } catch (error) {
        if (!absent(error)) throw error
        missing = error
      }
    }
    throw missing
  }
  return {
    load: (specifier) => attempt((base) => base(specifier)),
    resolve: (specifier) => attempt((base) => base.resolve(specifier)),
    adopt: (file) => {
      adopted = createRequire(file)
    }
  }
}
