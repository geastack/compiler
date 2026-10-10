// `||` OVER FIELDS OF AN `Object.create(null)` BAG TYPED BY ITS RETURN.
//
// A database client's `parseOptions(...): ClientOptions` builds
// `const clientOptions = Object.create(null)`, fills it, and refuses
// `!clientOptions.proxyHost && (clientOptions.proxyPort ||
// clientOptions.proxyUsername || clientOptions.proxyPassword)`. The checker
// types every read of the bag `any`; the values really held are a number and
// strings, and `||` yields the first truthy one (or the last operand).

interface ProxyOptions {
  proxyHost?: string
  proxyPort?: number
  proxyUsername?: string
  proxyPassword?: string
}

function parseProxy(host: string, port: number, user: string, pass: string): ProxyOptions {
  const options = Object.create(null)
  if (host.length > 0) options.proxyHost = host
  if (port > 0) options.proxyPort = port
  if (user.length > 0) options.proxyUsername = user
  if (pass.length > 0) options.proxyPassword = pass
  if (!options.proxyHost && (options.proxyPort || options.proxyUsername || options.proxyPassword)) {
    throw new Error('Must specify proxyHost if other proxy options are passed')
  }
  return options
}

const attempt = (host: string, port: number, user: string, pass: string): string => {
  try {
    const parsed = parseProxy(host, port, user, pass)
    return `ok:${parsed.proxyHost ?? '-'}:${parsed.proxyPort ?? '-'}`
  } catch (error) {
    return `refused:${(error as Error).message.split(' ')[0]}`
  }
}

//! expect: port=refused:Must user=refused:Must full=ok:proxy:8080 none=ok:-:-
console.log(
  `port=${attempt('', 8080, '', '')} user=${attempt('', 0, 'u', '')} full=${attempt('proxy', 8080, 'u', 'p')} none=${attempt('', 0, '', '')}`
)
