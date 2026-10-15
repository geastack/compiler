// node-compat's `net.Server`: `options = typeof optionsOrListener === 'function'
// ? {} : optionsOrListener` makes the options record a live view target (the
// `{}` arm is viewed as `ServerOpts`, every key forwarded to that empty
// source), while `createServer()` hands the constructor its own `= {}`
// default and a caller's literal -- plain allocations of the same record.
// Their slots are theirs: an absent one reads `undefined`, a present one its
// value, through the same receipt the view's forwarded routes answer with.
export {}

interface Options {
  allowHalfOpen?: boolean
  pauseOnConnect?: boolean
  delay?: number
}
type Listener = (value: number) => void

/** @gea-exact-arms */
function listenerArm(optionsOrListener: Options | Listener): Listener {
  return optionsOrListener as Listener
}

class Server {
  allowHalfOpen: boolean
  pauseOnConnect: boolean
  delay: number
  listeners: Listener[]
  constructor(listener?: Listener)
  constructor(options?: Options, listener?: Listener)
  constructor(optionsOrListener: Options | Listener = {}, connectionListener?: Listener) {
    const options = typeof optionsOrListener === 'function' ? {} : optionsOrListener
    const declared: Options | Listener = optionsOrListener
    const listener = typeof optionsOrListener === 'function' ? listenerArm(declared) : connectionListener
    this.allowHalfOpen = options.allowHalfOpen ?? false
    this.pauseOnConnect = options.pauseOnConnect ?? false
    this.delay = options.delay ?? 0
    this.listeners = []
    if (listener) this.listeners.push(listener)
  }
}

function createServer(listener?: Listener): Server
function createServer(options?: Options, listener?: Listener): Server
function createServer(optionsOrListener?: Options | Listener, listener?: Listener): Server {
  if (typeof optionsOrListener === 'function') return new Server(optionsOrListener)
  return new Server(optionsOrListener, listener)
}

const describe = (server: Server): string => `${server.allowHalfOpen} ${server.pauseOnConnect} ${server.delay} ${server.listeners.length}`

const listener: Listener = (value) => {
  void value
}
console.log('default', describe(createServer()))
console.log('options', describe(createServer({ pauseOnConnect: true, delay: 7 })))
console.log('both', describe(createServer({ allowHalfOpen: true }, listener)))
console.log('listener', describe(createServer(listener)))
//! expect: default false false 0 0
//! expect: options false true 7 0
//! expect: both true false 0 1
//! expect: listener false false 0 1
