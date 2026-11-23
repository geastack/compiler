// A response is `unknown`; the error result it carries is held in an
// `object | null` local -- the bare `object` keyword, which has no layout --
// and handed `as any` to a constructor taking a typed result interface. The
// constructor reads the result's fields through that interface, from the same
// object the response held.

export {}

type Document = { [key: string]: any }

interface WriteConcernErrorResult {
  writeConcernError: { code: number; errmsg: string; codeName?: string; errInfo?: Document }
  ok: number
  code?: number
  errorLabels?: string[]
  [x: string | number]: unknown
}

class Response {
  constructor(private readonly document: Document) {}
  static is(value: unknown): value is Response {
    return value instanceof Response
  }
  has(key: string): boolean {
    return key in this.document
  }
  toObject(): Document {
    return this.document
  }
}

class WriteConcernError extends Error {
  result: Document
  constructor(result: WriteConcernErrorResult) {
    super(result.writeConcernError.errmsg)
    this.result = result
  }
}

function throwIfWriteConcernError(response: unknown): void {
  if (typeof response === 'object' && response != null) {
    const writeConcernError: object | null =
      Response.is(response) && response.has('writeConcernError')
        ? response.toObject()
        : !Response.is(response) && 'writeConcernError' in response
          ? response
          : null
    if (writeConcernError != null) throw new WriteConcernError(writeConcernError as any)
  }
}

const responses: unknown[] = [
  new Response({ ok: 1, writeConcernError: { code: 64, errmsg: 'waiting' } }),
  new Response({ ok: 1 }),
  JSON.parse('{"ok":2,"writeConcernError":{"code":100,"errmsg":"parsed"}}')
]
for (const response of responses) {
  try {
    throwIfWriteConcernError(response)
    console.log('none')
  } catch (error) {
    const failure = error as WriteConcernError
    const same = Response.is(response) ? failure.result === response.toObject() : failure.result === response
    console.log(failure.message, failure.result.ok, same)
  }
}

//! expect: waiting 1 true
//! expect: none
//! expect: parsed 2 true
