// An HTTP server adapter's websocket module declares its own `CloseEvent` and
// `ErrorEvent` as class EXPRESSIONS behind a feature test, each forwarding its
// own init dictionary to the base constructor:
//
//   export const CloseEvent: typeof globalThis.CloseEvent = globalThis.CloseEvent ?? class extends Event {
//     #eventInitDict
//     constructor(type: string, eventInitDict: CloseEventInit = {}) {
//       super(type, eventInitDict)
//
// Each `super(...)` is a caller of the base constructor like any other, so
// every init shape forwarded that way is a value the base parameter holds.
interface BaseInit {
  bubbles?: boolean
}

class Base {
  readonly type: string
  constructor(type: string, _init?: BaseInit) {
    this.type = type
  }
}

class CloseImpl extends Base {
  readonly code: number
  constructor(type: string, init: { code?: number } = {}) {
    super(type)
    this.code = init.code ?? 0
  }
}

class ErrorImpl extends Base {
  readonly message: string
  constructor(type: string, init: { message?: string } = {}) {
    super(type)
    this.message = init.message ?? ''
  }
}

const platform = { Close: CloseImpl as typeof CloseImpl | undefined, Error: ErrorImpl as typeof ErrorImpl | undefined }

interface CloseInit extends BaseInit {
  code?: number
  wasClean?: boolean
}

interface ErrorInit extends BaseInit {
  message?: string
  error?: unknown
}

const FallbackClose: typeof CloseImpl =
  platform.Close ??
  class extends Base {
    #init

    constructor(type: string, init: CloseInit = {}) {
      super(type, init)
      this.#init = init
    }

    get code(): number {
      return this.#init.code ?? 0
    }
  }

const FallbackError: typeof ErrorImpl =
  platform.Error ??
  class extends Base {
    #init

    constructor(type: string, init: ErrorInit = {}) {
      super(type, init)
      this.#init = init
    }

    get message(): string {
      return this.#init.message ?? ''
    }
  }

const closing = new FallbackClose('close', { code: 1000 })
const failing = new FallbackError('error', { message: 'boom' })
//! expect: close 1000 error boom
console.log(closing.type + ' ' + closing.code + ' ' + failing.type + ' ' + failing.message)
