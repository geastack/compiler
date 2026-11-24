// A Function's own data read (`Bun?.version` off an ambient callable) is the
// ordinary checked lookup when no program write can install that key on a
// Function. A computed-key store into an options record whose FIELD holds a
// callback (`lookup`) writes the record, never the callback, so it does not
// make every Function key possibly installed.

export {}
declare const Bun: { (): void; version?: string } | undefined
type Document = { [key: string]: any }
interface ConnectOptions {
  host?: string
  port?: number
  servername?: string
  lookup?: (hostname: string) => string
}
const LEGAL = ['servername', 'port'] as const
function parse(options: ConnectOptions & { servername?: string; port?: number }): ConnectOptions {
  const result: ConnectOptions = { host: options.host ?? 'localhost', lookup: (name) => `${name}!` }
  for (const name of LEGAL) {
    if (options[name] != null) {
      ;(result as Document)[name] = options[name]
    }
  }
  return result
}
function runtimeInfo(): string {
  if ('Bun' in globalThis) {
    const version = typeof Bun?.version === 'string' ? Bun?.version : '0.0.0-unknown'
    return `Bun v${version}`
  }
  return 'Node'
}
const parsed = parse({ servername: 'db', port: 27017 })
console.log(parsed.host, parsed.servername, parsed.port, parsed.lookup?.('h'))
console.log(runtimeInfo())
//! expect: localhost db 27017 h!
//! expect: Node
