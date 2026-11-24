// An object literal's slot holds whatever a later store through any alias of
// it writes. Here `translate` replaces a plain options record with a class
// instance through its parameter, which is fed by a caller the value session
// does not enumerate, so the literal's slot is sized from that store too: the
// literal `{ readPreference: { ... } }` must hold the RP instance afterwards,
// never a record sliced out of it.

export {}
class RP {
  constructor(
    public mode: string,
    public tags?: string[]
  ) {}
  isOk(): boolean {
    return this.mode.length > 0
  }
}
interface LikeOpts {
  readPreference?: RP | string | { mode?: string; tags?: string[]; maxStalenessSeconds?: number }
}
interface FromOpts extends LikeOpts {
  hedge?: { enabled?: boolean }
}
function translate(options: LikeOpts): LikeOpts {
  const r = options.readPreference
  if (r && !(r instanceof RP) && typeof r === 'object') options.readPreference = new RP(r.mode ?? 'primary', r.tags)
  return options
}
function fromOptions(options?: FromOpts): LikeOpts | undefined {
  if (!options) return undefined
  return translate(options)
}
const base = new RP('secondary', ['a'])
const out = fromOptions({ readPreference: { ...base, maxStalenessSeconds: 5 } })
const rp = out?.readPreference
console.log(rp instanceof RP, rp instanceof RP ? rp.mode + ' ' + rp.isOk() + ' ' + (rp.tags ?? []).join(',') : 'no')
//! expect: true secondary true a
