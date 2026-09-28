// @ts-nocheck
//! dynamic-fallback
//! expect: default validator / default serializer
//! expect: default validator / custom serializer
// `Object.assign` of a literal with an `any` source may copy any key over
// any member the literal states, so the target is a dynamic object, and a
// record source copies into it field by field. fastify's schema-controller.
'use strict'
function build (opts) {
  const factory = Object.assign({ buildValidator: null, buildSerializer: null }, opts?.compilersFactory)
  if (!factory.buildValidator) factory.buildValidator = () => 'default validator'
  if (!factory.buildSerializer) factory.buildSerializer = () => 'default serializer'
  return factory.buildValidator() + ' / ' + factory.buildSerializer()
}
console.log(build(undefined))
console.log(build({ compilersFactory: { buildSerializer: () => 'custom serializer' } }))
