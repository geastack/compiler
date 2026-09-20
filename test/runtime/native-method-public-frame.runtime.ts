//! expect: frame 0 16 0
//! expect: saved 16
//! expect: captured 0 1
//! emitted-lacks: gea_cpp_value
//! emitted-lacks: gea::Value::box

class PublicFrameBase {
  total = 0
  hook(a: number, b: number, c: number): void
  hook(): void {}
}
class PublicFrameChild extends PublicFrameBase {
  offset = 10
}
function invokePublic(value: PublicFrameBase): void {
  value.hook(1, 2, 3)
}
const publicFrame = new PublicFrameChild()
const untouchedFrame = new PublicFrameChild()
const savedFrame = publicFrame.hook
const beforeFrame = publicFrame.total
publicFrame.hook = function (this: PublicFrameChild, a: number, b: number, c: number): void {
  this.total = this.offset + a + b + c
}
invokePublic(publicFrame)
invokePublic(untouchedFrame)
console.log('frame', beforeFrame, publicFrame.total, untouchedFrame.total)
savedFrame.call(publicFrame, 7, 8, 9)
console.log('saved', publicFrame.total)

class CapturedCounter {
  count = 0
  later() {
    return () => {
      this.count++
    }
  }
}
const capturedCounter = new CapturedCounter()
const capturedBefore = capturedCounter.count
capturedCounter.later()()
console.log('captured', capturedBefore, capturedCounter.count)
