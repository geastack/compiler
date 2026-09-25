'use strict'

function noop() {}

const proto = { info: noop }

Object.defineProperty(module, 'exports', {
  get() {
    return Object.create(proto)
  }
})
