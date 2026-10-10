// An open `Document` spread with two more keys into a const, then returned as
// a member of a literal whose declared type is again the open `Document` --
// a cloud key-service client's `prepareRequest`. The const keeps the source's dynamic
// keys, and so does the member it becomes.

interface WireDocument {
  [key: string]: any
}

interface RequestOptions {
  headers?: WireDocument
  url?: string
}

function prepareRequest(options: RequestOptions): { headers: WireDocument; url: string } {
  const url = options.url ?? 'http://169.254.169.254/metadata/identity/oauth2/token'
  const headers = { ...options.headers, 'Content-Type': 'application/json', Metadata: true }
  return { headers, url }
}

const request = prepareRequest({ headers: { Authorization: 'x' } })
// Sorted: the spread's `Authorization` lands in the record's sidecar and the
// two literal members in its layout, which lists them first. A record learns
// a creation order from a spread only where the copied run holds a key its
// layout declares (`gea::detail::learnCopiedOwnKeys`); the layout does not
// record where a spread of keys it never declared stood, and keeping the
// literal's own members first is what `{ find: name, ...options }` needs.
//! expect: Authorization,Content-Type,Metadata
console.log(Object.keys(request.headers).sort().join(','))
//! expect: x application/json true
console.log(request.headers['Authorization'], request.headers['Content-Type'], request.headers['Metadata'])
//! expect: Content-Type,Metadata
console.log(Object.keys(prepareRequest({}).headers).join(','))
