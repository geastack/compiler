//! expect: URIError: URI malformed
//! expect: instance=true
//! expect: message=URI malformed
//! expect: decoded=/a b/✓
//! expect: encoded=%E2%9C%93

try {
  decodeURIComponent('%FF')
} catch (error) {
  console.log(String(error))
  console.log('instance=' + (error instanceof URIError))
  console.log('message=' + (error as Error).message)
}
console.log('decoded=' + decodeURIComponent('/a%20b/%E2%9C%93'))
console.log('encoded=' + encodeURIComponent('✓'))
