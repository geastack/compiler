//! expect: code=null signal=SIGTERM
//! expect: code=3 signal=null
//! emitted-has: .has_value() ?
// An absent `T | null` passed where `any` is declared must box as `null`, not
// as the payload's C++ default. The rest parameter is the shape every
// EventEmitter listener sees: `emit(name, ...args: any[])`.
function report(...args: any[]): void {
  const code = args[0]
  const signal = args[1]
  console.log('code=' + (code === null ? 'null' : String(code)) + ' signal=' + (signal === null ? 'null' : String(signal)))
}

function exitOf(flag: boolean): number | null {
  return flag ? 3 : null
}

function signalOf(flag: boolean): string | null {
  return flag ? null : 'SIGTERM'
}

const killed = exitOf(false)
const killedSignal = signalOf(false)
report(killed, killedSignal)
const exited = exitOf(true)
const exitedSignal = signalOf(true)
report(exited, exitedSignal)
