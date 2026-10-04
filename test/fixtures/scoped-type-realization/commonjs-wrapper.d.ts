// The CommonJS wrapper cells a host states as `commonJsGlobals`; only
// `scoped-type-realization.mjs`'s census test names this file.
export {}
declare global {
  var require: (specifier: string) => any
  var exports: any
  var module: { exports: any }
}
