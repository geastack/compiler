const routePattern = (tokens: string[], index = 0): string => {
  if (tokens.length === 0) return 'none'
  const [token] = tokens
  const pattern = token === '*' ? ['', '', '.*'] : token === '/*' ? ['', '', '.*'] : token.match(/^:([^{}]+)(?:{(.+)})?$/)

  if (!pattern) return 'none'
  const name = pattern[1]
  const body = pattern[2] || '[^/]+'
  return `${name}:${body}`
}

console.log(routePattern(['*']))
console.log(routePattern([':id']))
console.log(routePattern([':id{\\d+}']))

//! expect: :.*
//! expect: id:[^/]+
//! expect: id:\d+
