//! expect: 8 8 32
//! expect: 0 16 16
//! expect: 4 12 32
//! expect: view 16
//! expect: view 8
//! expect: view 12
//! expect: buffer 32
//! expect: none
//! expect: dataview 7
//! expect: true false

// WebGL's `bufferData(target, srcData: AllowSharedBufferSource | null, usage)`
// takes any typed array, a DataView, or a bare buffer. lib's ArrayBufferView is
// a WebIDL typedef over those views, so each one reaches the slot as itself
// rather than as a record shaped like the interface. The parameter receives an
// `ArrayBufferView[]` element, so no caller-side narrowing can stand in for the
// sum.
export {}

interface Upload {
  data: AllowSharedBufferSource | null
}
function windowOf(view: ArrayBufferView): string {
  return `${view.byteOffset} ${view.byteLength} ${view.buffer.byteLength}`
}
const backing = new ArrayBuffer(32)
const floats = new Float32Array(backing, 8, 2)
const indexes = new Uint32Array(4)
const bytes = new DataView(backing, 4, 12)
bytes.setUint8(0, 7)
const views: ArrayBufferView[] = [floats, indexes, bytes]
for (const view of views) console.log(windowOf(view))
const uploads: Upload[] = [{ data: indexes }, { data: floats }, { data: bytes }, { data: backing }, { data: null }]
for (const upload of uploads) {
  const data = upload.data
  if (data === null) console.log('none')
  else if (ArrayBuffer.isView(data)) console.log(`view ${data.byteLength}`)
  else console.log(`buffer ${data.byteLength}`)
}
const last = views[2]
if (last instanceof DataView) console.log(`dataview ${last.getUint8(0)}`)
console.log(views[0] instanceof Float32Array, views[1] instanceof Float32Array)
