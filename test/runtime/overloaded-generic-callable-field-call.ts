//! expect: hi
//! expect: hi:404
//! expect: hi:500

interface TextInit {
  code: number
}

interface TextRespond {
  <T extends string, U extends number = number>(text: T, status?: U, headers?: string): string
  <T extends string, U extends number = number>(text: T, init?: TextInit): string
}

class Responder {
  text: TextRespond = (text: string, arg?: number | TextInit, _headers?: string): string => {
    if (typeof arg === 'number') return `${text}:${arg}`
    if (arg) return `${text}:${arg.code}`
    return text
  }
}

const responder = new Responder()
console.log(responder.text('hi'))
console.log(responder.text('hi', 404))
console.log(responder.text('hi', { code: 500 }))
