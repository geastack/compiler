// A cloud key-service request's `options.url?.toString() ?? BASE_URL` with
// `url?: URL | string`, where `ConnectionString extends URL` overrides
// `toString`: the call on the union's class arm must run the allocated
// object's own override, not the base's.

class SiteUrl {
  constructor(readonly href: string) {}
  toString(): string {
    return this.href
  }
}

class RedactedSiteUrl extends SiteUrl {
  override toString(): string {
    return this.href.replace(/:[^@/]*@/, ':****@')
  }
}

interface RequestOptions {
  url?: SiteUrl | string
}

function resolve(options: RequestOptions): string {
  return options.url?.toString() ?? 'https://default.example/'
}

console.log(resolve({}))
console.log(resolve({ url: 'https://plain.example/' }))
console.log(resolve({ url: new SiteUrl('https://base.example/') }))
console.log(resolve({ url: new RedactedSiteUrl('db://user:secret@host/') }))

//! expect: https://default.example/
//! expect: https://plain.example/
//! expect: https://base.example/
//! expect: db://user:****@host/
