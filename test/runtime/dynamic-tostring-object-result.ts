//! expect-abort
//! dynamic-fallback

const value: any = {}
value.toString = function () {
  return {}
}
value.valueOf = function () {
  return {}
}

console.log(String(value))
