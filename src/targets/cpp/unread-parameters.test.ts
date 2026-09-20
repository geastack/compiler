import assert from 'node:assert/strict'
import test from 'node:test'
import { withUnreadParametersUnnamed } from './records.js'

test('unnaming body parameters preserves a callable return ABI', () => {
  const result = 'gea::CallableObject<void(gea::Ref<C>, gea_union_9, gea::Optional<gea::Ref<R>>)>'
  assert.equal(
    withUnreadParametersUnnamed(`${result} body(double gea_arg_0, double gea_arg_1)`, ['return choose(gea_arg_0);']),
    `${result} body(double gea_arg_0, double )`
  )
})

test('unnaming preserves nested callable parameters and default arguments', () => {
  assert.equal(
    withUnreadParametersUnnamed('void hook(gea::CallableObject<void(double)> gea_callback, bool gea_flag = true)', []),
    'void hook(gea::CallableObject<void(double)> , bool = true)'
  )
})

test('an already unnamed native type is not a parameter name', () => {
  assert.equal(withUnreadParametersUnnamed('void hook(gea_union_9)', []), 'void hook(gea_union_9)')
  assert.equal(withUnreadParametersUnnamed('void hook(double, gea_union_9)', []), 'void hook(double, gea_union_9)')
})
