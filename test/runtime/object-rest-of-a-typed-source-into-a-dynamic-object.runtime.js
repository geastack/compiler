// @ts-nocheck
//! dynamic-fallback
//! expect: custom,merged version host
// `const { a, b, ...rest } = typed` where `rest` later takes a computed key:
// the rest object is CopyDataProperties of the typed source onto a fresh
// ordinary object.
function Holder () { this.strategies = { version: { name: 'version' }, host: { name: 'host' }, custom: { name: 'custom' } } }
const extra = JSON.parse('{"name":"merged"}')
function merged (holder) {
  const { version, host, ...constraints } = holder.strategies
  constraints[extra.name] = extra
  return Object.keys(constraints).join(',') + ' ' + version.name + ' ' + host.name
}
console.log(merged(new Holder()))
