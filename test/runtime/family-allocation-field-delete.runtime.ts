//! expect: before 1 true
//! expect: after undefined false keys id,yaw,update
//! expect: again 3 true keys id,yaw,update,mark
//! expect: yaw 3
//! emitted-has: gea_present_mark ?
//! emitted-has: presentOrThrow(v0->yaw)
// A key the program deletes stays behind its presence test, even read
// through the cell holding the one literal that wrote it: the allocation
// raised the bit, and `delete` lowers it again. A key nothing deletes from the
// same object (`yaw`) still reads straight off its member.

interface Base {
  id: number
  update(): void
}
interface Marked extends Base {
  mark?: number
  yaw: number
}
interface Plain extends Base {
  yaw: number
}

const make = (): Marked => {
  const marked: Marked = {
    id: 1,
    mark: 1,
    yaw: 0,
    update() {
      marked.yaw += 1
      console.log('before', marked.mark, 'mark' in marked)
      delete marked.mark
      console.log('after', marked.mark, 'mark' in marked, 'keys', Object.keys(marked).join(','))
      marked.mark = 3
      console.log('again', marked.mark, 'mark' in marked, 'keys', Object.keys(marked).join(','))
      marked.yaw += 2
    }
  }
  return marked
}
const plain: Plain = { id: 2, yaw: 0, update() {} }
const one = make()
one.update()
plain.update()
console.log('yaw', one.yaw + plain.yaw)
