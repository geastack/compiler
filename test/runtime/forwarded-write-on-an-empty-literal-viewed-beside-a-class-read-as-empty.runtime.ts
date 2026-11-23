// A database driver copies socket options by name (`options[name]` over a
// list of keys) into a value union whose object arm is `{}`, so the class
// instance one of those keys holds is read as a live view of `{}`. Elsewhere
// an options parameter defaults to a `{}` literal viewed as the options
// interface, and a named key the literal lacks is assigned through that view.
// Every live view of `{}` is one shape, but the class instance read as `{}`
// never reaches the options parameter: the store lands in the literal's own
// expando, and reads it back.

export {}

class AuthProviders {
  private readonly cache = new Map<string, number>()
  remember(name: string): number {
    this.cache.set(name, name.length)
    return this.cache.size
  }
}

interface ConnectOptions {
  host: string
  port: number
  keepAlive: boolean
  providers: AuthProviders
}

type Copied = string | number | boolean | {}

const LEGAL = ['host', 'port', 'keepAlive', 'providers'] as const

function copyOptions(options: ConnectOptions): Copied[] {
  const out: Copied[] = []
  for (const name of LEGAL) {
    const held: Copied = options[name]
    out.push(held)
  }
  return out
}

interface ReadOptions {
  level?: number
  label?: string
}

function configure(options: ReadOptions = {}): string {
  options.level = (options.level ?? 0) + 1
  options.label = 'read'
  return `${options.level}:${options.label}:${Object.keys(options).join(',')}`
}

const providers = new AuthProviders()
providers.remember('scram')
const copied = copyOptions({ host: 'localhost', port: 27017, keepAlive: true, providers })
console.log(copied.length, copied[3] === providers, typeof copied[0], typeof copied[1])
console.log(configure())
console.log(configure({ level: 4 }))

//! expect: 4 true string number
//! expect: 1:read:level,label
//! expect: 5:read:level,label
