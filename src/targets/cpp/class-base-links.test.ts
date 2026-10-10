import assert from 'node:assert/strict'
import test from 'node:test'
import type { DeclarationId } from '../../identity/ids.js'
import type { ClassLayout } from '../../projection/classes.js'
import { cppErrorNativeType } from './error-types.js'
import { classBaseLinks } from './records.js'
import { cppClassName } from './types.js'

type BaseLayout = Pick<ClassLayout, 'declaration' | 'base' | 'nativeBase' | 'instance'>
type NativeInstance = NonNullable<ClassLayout['nativeBase']>['instance']

const nativeRecord = (native: string, ownership: string): NativeInstance =>
  ({ kind: 'native-record-ref', native, shapeId: 'shape', ownership }) as unknown as NativeInstance

const layoutOf = (declaration: string, instance: NativeInstance): BaseLayout => ({
  declaration: declaration as DeclarationId,
  base: null,
  nativeBase: { protocol: 'Base', instance },
  instance: null
})

test('only the runtime error record is published as a native error base', () => {
  const layouts = new Map<DeclarationId, BaseLayout>([
    ['error-child' as DeclarationId, layoutOf('error-child', nativeRecord(cppErrorNativeType, 'shared-refcount'))],
    ['other-child' as DeclarationId, layoutOf('other-child', nativeRecord('gea::runtime::Other', 'shared-refcount'))]
  ])
  const { links } = classBaseLinks(layouts)
  assert.equal(links.get(cppClassName('error-child' as DeclarationId))?.nativeError, true)
  assert.equal(links.get(cppClassName('other-child' as DeclarationId))?.nativeError, undefined)
  assert.equal(links.get(cppClassName('other-child' as DeclarationId))?.native, true)
})
