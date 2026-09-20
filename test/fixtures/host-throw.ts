// `throw new Error(m)` end to end: the ambient `Error` global resolves through
// its VALUE declaration (`declare var Error`, not `interface Error`), the
// construct reaches `gea::host::ErrorConstructor::create`, and the terminator
// renders a C++ `throw` of the carrier the constructor actually produced.
//
// No handler is claimed alongside it, and that is complete rather than partial:
// an uncaught `throw` terminating the process is what an uncaught ECMAScript
// exception does. `try`/`catch` is a separate, unmade catch-side decision.
export const refuse = (reason: string): never => {
  throw new Error(reason)
}

// Called at module scope so the body is emitted rather than shaken away. The
// call is guarded so the module body itself does not unconditionally throw.
export const probe = (flag: boolean): string => {
  if (flag) refuse('no')
  return 'ok'
}
export const probeCall = probe(false)
