//! expect: visible=true,false,true,false,true,false,true,false,true,false,true,false
//! expect: missing=undefined,false
//! expect: after=0,2,3,4,5,6,7,8,9,10,11,12,1
//! expect: records=a:1,b:2,c:3,d:4,e:5,f:6,g:7,h:8,i:9,j:10|size=10
//! expect: same=true,false
// A \`Map\` keyed by objects past its index threshold looks keys up by
// identity (instance-culling's \`Map<Batch, boolean>\` read per batch per frame
// was a scan of every entry). Insertion order, delete-and-reinsert, distinct
// objects with equal contents and re-set keys must all stay the language's.

class Mesh {
  id: number
  visible: boolean
  constructor(id: number, visible: boolean) {
    this.id = id
    this.visible = visible
  }
}
interface Batch {
  name: string
  count: number
}

const meshes: Mesh[] = []
for (let index = 1; index <= 12; index++) meshes.push(new Mesh(index, index % 2 === 1))
const visible = new Map<Mesh, boolean>()
for (const mesh of meshes) visible.set(mesh, mesh.visible)
console.log('visible=' + meshes.map((mesh) => String(visible.get(mesh))).join(','))
const stranger = new Mesh(1, true)
console.log('missing=' + String(visible.get(stranger)) + ',' + String(visible.has(stranger)))

const first = meshes[0]!
visible.delete(first)
visible.set(meshes[4]!, false)
visible.set(first, true)
const order: number[] = []
for (const [mesh] of visible) order.push(mesh.id)
console.log('after=' + [0, ...order].join(','))

const batches = new Map<Batch, number>()
const names = 'abcdefghij'.split('')
const list: Batch[] = names.map((name, index) => ({ name, count: index + 1 }))
for (const batch of list) batches.set(batch, batch.count)
for (const batch of list) batches.set(batch, batches.get(batch) ?? -1)
console.log('records=' + list.map((batch) => `${batch.name}:${batches.get(batch)}`).join(',') + '|size=' + batches.size)
const twin: Batch = { name: 'a', count: 1 }
console.log('same=' + batches.has(list[0]!) + ',' + batches.has(twin))
