//! expect: true 1 false false true 2
// ajv's `for (const opt of META_IGNORE_OPTIONS) delete metaOpts[opt]`: a
// computed delete whose key is a closed set of optional option names, over a
// record copied out of the options it strips.
interface Options {
  strict?: boolean
  useDefaults?: boolean
  coerceTypes?: boolean
  loopRequired: number
}
const IGNORED = ['useDefaults', 'coerceTypes'] as const
function metaOptions(opts: Options): Options {
  const meta = { ...opts }
  for (const opt of IGNORED) delete meta[opt]
  return meta
}
const opts: Options = { strict: true, useDefaults: true, coerceTypes: false, loopRequired: 1 }
const meta = metaOptions(opts)
console.log(meta.strict, meta.loopRequired, 'useDefaults' in meta, 'coerceTypes' in meta, opts.useDefaults, Object.keys(meta).length)
