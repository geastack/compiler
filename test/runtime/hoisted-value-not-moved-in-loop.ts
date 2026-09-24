//! expect: strings x!,x!,x! ab|ab|ab|ab
//! expect: mips 1@0:128 1@1:64 1@2:32 1@3:16 1@4:8 1@0:128 1@1:64 1@2:32 1@3:16 1@4:8 2@0:64 2@1:32 2@2:16
// A value the loop cannot change is hoisted above the loop, but the move
// census had already decided it dies at its one use -- in the IR both sat in
// the loop body's block, so the use looked like the definition's last. The
// printed C++ defined it once in the preheader and `std::move`d it into the
// call on every iteration: every later iteration saw an empty string, and
// skytail's mip-upload loop passed a null GPUTexture to every level after the
// first and crashed (skytail a2bab0f).
function keep(out: string[], s: string): void {
  out.push(s)
}
function repeat(a: string, n: number): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) keep(out, a + '!')
  return out.join(',')
}
function fixedRepeat(a: string, b: string): string {
  const out: string[] = []
  for (let i = 0; i < 4; i++) keep(out, a + b)
  return out.join('|')
}
console.log('strings', repeat('x', 3), fixedRepeat('a', 'b'))

class Tex {
  readonly id: number
  constructor(id: number) {
    this.id = id
  }
  destroy(): void {}
}
class TextureRecord {
  texture: Tex | null = null
  width = 0
  levels = 1
}
class Queue {
  writes: string[] = []
  writeTexture(dest: { texture: Tex; mipLevel?: number }, size: number): void {
    this.writes.push(`${dest.texture.id}@${dest.mipLevel ?? 0}:${size}`)
  }
}
class TextureCache {
  queue = new Queue()
  next = 1
  records = new Map<number, TextureRecord>()
  view(id: number, width: number, levels: number): void {
    let record = this.records.get(id)
    if (record === undefined) {
      record = new TextureRecord()
      this.records.set(id, record)
    }
    let gpuTexture = record.texture
    if (gpuTexture === null || record.width !== width || record.levels !== levels) {
      if (gpuTexture !== null) gpuTexture.destroy()
      gpuTexture = new Tex(this.next++)
      record.texture = gpuTexture
      record.width = width
      record.levels = levels
    }
    this.queue.writeTexture({ texture: gpuTexture }, width)
    if (levels > 1) {
      const chain: number[] = []
      for (let level = 0; level < levels; level++) chain.push(width >> level)
      for (let level = 1; level < chain.length; level++) this.writeLevel(gpuTexture, level, chain[level] ?? 0)
    }
  }
  private writeLevel(texture: Tex, level: number, size: number): void {
    this.queue.writeTexture({ texture, mipLevel: level }, size)
  }
}
const cache = new TextureCache()
cache.view(1, 128, 5)
cache.view(1, 128, 5)
cache.view(2, 64, 3)
console.log('mips', cache.queue.writes.join(' '))
