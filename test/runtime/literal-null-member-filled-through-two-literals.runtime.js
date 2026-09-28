// @ts-nocheck
//! dynamic-fallback
//! expect: {"headers":{"a":"1","b":"x,y","date":"today"}}
// light-my-request's `Response`: `_lightMyRequest` is one of two literals,
// each with `headers: null`, filled later through the union.
function LightResponse (flag) {
  if (flag) this._state = { headers: null, trailers: {}, stream: null }
  else this._state = { headers: null, trailers: {}, payloadChunks: [] }
}
LightResponse.prototype.getHeaders = function () { return JSON.parse('{"a":"1","b":["x","y"]}') }
function copyHeaders (response) {
  response._state.headers = Object.assign({}, response.getHeaders())
  ;['Date'].forEach((name) => { response._state.headers[name.toLowerCase()] = 'today' })
}
function serializeHeaders (response) {
  const headers = response._state.headers
  for (const headerName of Object.keys(headers)) {
    const headerValue = headers[headerName]
    headers[headerName] = Array.isArray(headerValue) ? headerValue.join(',') : '' + headerValue
  }
}
const response = new LightResponse(false)
if (response._state.headers === null) copyHeaders(response)
serializeHeaders(response)
console.log(JSON.stringify({ headers: response._state.headers }))
