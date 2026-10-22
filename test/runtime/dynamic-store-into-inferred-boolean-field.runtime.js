// @ts-nocheck
// The boolean-field form of an inferred field receiving a dynamic store.
class Flag {
  constructor() {
    this.enabled = true
  }
  copy(source) {
    this.enabled = source.enabled
    return this
  }
}

const show = (value) => `${typeof value}:${value}`
const inputs = ['{"enabled":false}', '{}', '{"enabled":null}', '{"enabled":"yes"}', '{"enabled":0}']
for (const text of inputs) {
  const flag = new Flag().copy(JSON.parse(text))
  console.log(show(flag.enabled), flag.enabled ? 'on' : 'off')
}
//! expect: boolean:false off
//! expect: undefined:undefined off
//! expect: object:null off
//! expect: string:yes on
//! expect: number:0 off
export {}
