//! expect: 1 true base/path
// ajv's `requiredOptions`: the returned literal's `code` is an inline literal
// (`{...o.code, optimize, regExp}`) where the interface names
// `InstanceCodeOptions`, and its `uriResolver` is `o.uriResolver ??
// DefaultUriResolver` -- the caller's resolver or a module's own object --
// where `UriResolver` is named. Each member is read as the interface it is
// declared as.
interface UriResolver {
  parse(uri: string): { path: string }
  resolve(base: string, path: string): string
}
const DefaultUriResolver = {
  parse: (uri: string) => ({ path: uri }),
  resolve: (base: string, path: string) => `${base}/${path}`,
  name: 'default'
}
interface CodeOptions {
  es5?: boolean
  optimize?: number
}
interface InstanceCodeOptions extends CodeOptions {
  optimize: number
  regExp: (pattern: string) => RegExp
}
interface RequiredOptions {
  code: InstanceCodeOptions
  uriResolver: UriResolver
}
function requiredOptions(o: { code?: CodeOptions; uriResolver?: UriResolver }): RequiredOptions {
  const optimize = o.code?.optimize ?? 1
  const uriResolver = o.uriResolver ?? DefaultUriResolver
  return { code: { ...o.code, optimize, regExp: (pattern) => new RegExp(pattern) }, uriResolver }
}
const options = requiredOptions({ code: { es5: false } })
console.log(options.code.optimize, options.code.regExp('a+').test('aa'), options.uriResolver.resolve('base', 'path'))
