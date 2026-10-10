//! expect: document:false
//! expect: none

// A database client's `throwIfWriteConcernError(response: unknown)`: a reply that is
// not a `ServerResponse` is tested with `'writeConcernError' in response`,
// and the conditional `cond ? response : null` is stored as `object | null`.
// The only instance flowing in is a class, so `response` is carried as that
// class and the `null` arm as its empty handle -- which must stay `null` in
// the `object | null` slot rather than become an object with nothing in it.

class ServerResponse {
  static is(value: unknown): value is ServerResponse {
    return value instanceof ServerResponse
  }
  has(name: string): boolean {
    return name === 'ok'
  }
  toObject(): Record<string, unknown> {
    return { ok: 1 }
  }
}

function writeConcernErrorOf(response: unknown): object | null {
  if (typeof response === 'object' && response != null) {
    const writeConcernError: object | null =
      ServerResponse.is(response) && response.has('writeConcernError')
        ? response.toObject()
        : !ServerResponse.is(response) && 'writeConcernError' in response
          ? response
          : null
    return writeConcernError
  }
  return null
}

console.log('document:' + String(writeConcernErrorOf(new ServerResponse()) != null))
const none = writeConcernErrorOf(new ServerResponse())
console.log(none === null ? 'none' : 'object')
