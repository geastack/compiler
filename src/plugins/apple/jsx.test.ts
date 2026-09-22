import assert from 'node:assert/strict'
import test from 'node:test'
import { appleJsxTransform } from './jsx.js'

// These read the installed @geastack/apple SDK tables, the same way the
// transform does for a real program; a machine without the SDK skips them.
const sdkPresent = (): boolean => appleJsxTransform({ fileName: 'probe.tsx', text: '<UIView/>' }) !== null

const rewrite = (text: string): string => {
  const out = appleJsxTransform({ fileName: 'app.tsx', text })
  assert.ok(out !== null, 'the element is claimed')
  return out
}

test('children of a UIVisualEffectView are added to its contentView', { skip: !sdkPresent() }, () => {
  // UIKit asserts inside `-[UIVisualEffectView _addSubview:]`: subviews belong
  // to the effect view's contentView, and the crash is at launch, not compile.
  const out = rewrite('const card = <UIVisualEffectView alpha={0.9}>{badge()}<UILabel text="hi"/></UIVisualEffectView>')
  assert.match(out, /__geaAppleView0\.contentView!\.addSubview\(badge\(\)\);/)
  assert.match(out, /__geaAppleView0\.contentView!\.addSubview\(\(\(\) => \{ const __geaAppleView1 = new UILabel\(\);/)
  assert.doesNotMatch(out, /__geaAppleView0\.addSubview\(/)
})

test('a plain view and a stack view keep their own child adders', { skip: !sdkPresent() }, () => {
  const plain = rewrite('const v = <UIView>{child()}</UIView>')
  assert.match(plain, /__geaAppleView0\.addSubview\(child\(\)\);/)
  assert.doesNotMatch(plain, /contentView/)
  const stack = rewrite('const s = <UIStackView>{child()}</UIStackView>')
  assert.match(stack, /__geaAppleView0\.addArrangedSubview\(child\(\)\);/)
  assert.doesNotMatch(stack, /contentView/)
})
