// @ts-nocheck
//! expect: true true true false false true
// `in` with a static key over a host handle: its own members are the ones its
// host declares, behind them Function.prototype (for a constructor) and
// Object.prototype. fastify's `if ('asyncDispose' in Symbol)`.
'use strict'
console.log('asyncDispose' in Symbol, 'iterator' in Symbol, 'bind' in Symbol, 'nope' in Math, 'bind' in Math, 'toString' in Math)
