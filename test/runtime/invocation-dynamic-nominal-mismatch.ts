//! expect-abort
//! dynamic-fallback

class Expected {
  value = 1
}

class Wrong {
  value = 1
}

function consume(value: Expected): number {
  return value.value
}

// Matching structure is not an invocation-argument conversion. The selected
// nominal slot must reject the dynamically carried wrong class.
const forged: any = new Wrong()
console.log(consume(forged))
