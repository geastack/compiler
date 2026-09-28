//! expect: log true 4 extra | true true 2 -
// ajv's `opts = this.opts = {...opts, ...requiredOptions(opts)}`: the first
// spread's source has every field optional, the literal's own fields are
// required, and the second spread writes each of them. A required field the
// first copy may leave unset is set before anything reads the literal.
interface Options {
  strict?: boolean | 'log'
  validateFormats?: boolean
  loopRequired?: number
  extra?: string
}
interface ResolvedOptions {
  strict: boolean | 'log'
  validateFormats: boolean
  loopRequired: number
}
function requiredOptions(o: Options): ResolvedOptions {
  return { strict: o.strict ?? true, validateFormats: o.validateFormats ?? true, loopRequired: o.loopRequired ?? 2 }
}
class Core {
  readonly opts: ResolvedOptions & { extra?: string }
  constructor(opts: Options = {}) {
    this.opts = { ...opts, ...requiredOptions(opts) }
  }
}
const describe = (core: Core): string =>
  `${core.opts.strict} ${core.opts.validateFormats} ${core.opts.loopRequired} ${core.opts.extra ?? '-'}`
console.log(describe(new Core({ strict: 'log', loopRequired: 4, extra: 'extra' })), '|', describe(new Core()))
