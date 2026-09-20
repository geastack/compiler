interface Msg {
  code: number
  text: string
}
type Arg = string | number
interface Opt {
  name: string
  extra?: (value: string) => [Msg, ...Arg[]] | undefined
}
const errors: string[] = []
function report(prefix: string, message: Msg, ...args: Arg[]): void {
  errors.push(`${prefix}:${message.code}:${message.text}:${args.join(',')}`)
}
function validate(opt: Opt, value: string): string | undefined {
  const d = opt.extra?.(value)
  if (!d) return value
  report('E', ...d)
  return undefined
}
const strict: Opt = { name: 'strict', extra: (value) => (value === 'ok' ? undefined : [{ code: 7, text: 'bad' }, value, 2]) }
const loose: Opt = { name: 'loose' }
console.log(validate(strict, 'ok'), validate(strict, 'no'), validate(loose, 'no'), errors.length, errors[0])
//! expect: ok undefined no 1 E:7:bad:no,2
