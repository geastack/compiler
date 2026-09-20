type BodyMethod = 'text' | 'json'

class NativeRequestLike {
  marker = 'own'

  text(): string {
    return 'text-body'
  }

  json(): string {
    return 'json-body'
  }
}

const invokeBodyMethod = (request: NativeRequestLike, key: BodyMethod): string => request[key]()
const request = new NativeRequestLike()

//! expect: text-body
console.log(invokeBodyMethod(request, 'text'))

//! expect: json-body
console.log(invokeBodyMethod(request, 'json'))

//! expect: marker
console.log(Object.keys(request).join(','))
