// What a REJECTED property write and a rejected redefinition do.
//
// There is no sloppy half any more, and that is a fact about the build rather
// than a decision here: `module: ESNext` makes every program an ES module, and
// an ES module is strict in its entirety (ECMA-262 11.2.2). The old
// `sloppyWrite` had no `'use strict'` prologue and expected the store to be
// silently dropped -- real `node` throws there, verified on this file's own
// emitted module, so `sloppy 1` was a line no correct compiler could print.
//
// `(void)gea_arg_0.reflectSet(` went with it: that is the emission for a store
// whose failure is DISCARDED, which is the sloppy lowering. No program in this
// suite can reach it, so pinning it here pinned an emission the suite cannot
// produce. The checked form below is still pinned, and is what both writes now
// compile to.
//! expect: strict TypeError 1
//! expect: rejected TypeError 1
//! expect: define TypeError 1
//! emitted-has: if (!gea_arg_0.reflectSet(
//! emitted-has: Cannot assign to read-only property
//! emitted-has: if (!gea::nativeDynamicDefineProperty
//! emitted-has: Cannot define native property
//! emitted-lacks: .setProperty(

function strictWrite(target: any): string {
  'use strict'
  try {
    target.locked = 2
    return 'missing'
  } catch (error) {
    return (error as Error).name
  }
}

// Strict like everything else in a module, so the rejection is observable as a
// throw rather than as a silently unchanged value.
function rejectedWrite(target: any): string {
  try {
    target.locked = 3
    return 'missing'
  } catch (error) {
    return (error as Error).name
  }
}

const dynamicTarget: any = {}
Object.defineProperty(dynamicTarget, 'locked', { value: 1, writable: false, configurable: false })
console.log('strict', strictWrite(dynamicTarget), dynamicTarget.locked)
console.log('rejected', rejectedWrite(dynamicTarget), dynamicTarget.locked)

function rejectNativeDefine(nativeTarget: { fixed: number } | undefined): void {
  Object.defineProperty(nativeTarget!, 'sidecar', { value: 1, writable: false, configurable: false })
  try {
    Object.defineProperty(nativeTarget!, 'sidecar', { value: 2 })
    console.log('define missing')
  } catch (error) {
    console.log('define', (error as Error).name, (nativeTarget as any).sidecar)
  }
}

rejectNativeDefine({ fixed: 1 })
