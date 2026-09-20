// A declared type that a host-binding policy can name by declaration
// identity. Compiled with no policy installed (the CLI's default), `Handle`
// derives exactly as any other declared interface does today: nominally, by
// `native-record-ref`. `scripts/probe-host-binding.mjs` recompiles this same
// file with a policy that binds `Handle`'s declaration to a protocol, and
// checks that the very same structural type then derives `native-handle`
// instead -- proving the switch is the injected policy, not this file.

export interface Handle {
  readonly id: number
}

export const identity = (handle: Handle): Handle => handle

// Called at module scope so the body is emitted rather than shaken away.
export const probe = identity({ id: 1 })
