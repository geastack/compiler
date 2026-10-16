//! expect: absent depth=undefined width=2 complete=undefined
//! expect: original depth=7
//! expect: through depth=5 original=5

// three's DataTexture image read back by native-webgl-angle's
// requireTextureImageRecord: the image literal is stored in the all-optional
// record, seen as the exact {data,width,height} shape (a family of its own,
// so a view), and handed back as the all-optional shape (a view over that
// view). `depth` is declared by the original but absent, so the outer view's
// read must answer undefined, live, without a copy.
type FullImage = { data?: Float32Array; width?: number; height?: number; depth?: number; complete?: boolean }
type ExactImage = { data: Float32Array; width: number; height: number }
type UploadImage = { data: Float32Array; width: number; height: number; label?: string }

function upload(source: UploadImage): number {
  return source.width * source.height
}
function exactOf(value: ExactImage): ExactImage {
  upload(value)
  return value
}

let sink: FullImage | FullImage[] | null = null
function store(value: FullImage | FullImage[] | null): void {
  sink = value
}

function requireImageRecord(value: FullImage | FullImage[] | null | undefined): FullImage {
  if (
    value !== null &&
    value !== undefined &&
    !Array.isArray(value) &&
    typeof value.width === 'number' &&
    typeof value.height === 'number'
  ) {
    return {
      data: value.data,
      width: value.width,
      height: value.height,
      depth: value.depth,
      complete: 'complete' in value ? value.complete : undefined
    }
  }
  throw new Error('not a dimensioned image record')
}

const literal = { data: new Float32Array(4), width: 2, height: 1 }
store(literal)
store(exactOf(literal))
const absent = requireImageRecord(sink)
console.log('absent depth=' + absent.depth + ' width=' + absent.width + ' complete=' + absent.complete)

// A present field still reads through the views from the original.
const original = literal as FullImage
original.depth = 7
console.log('original depth=' + requireImageRecord(sink).depth)
const viewed = sink as FullImage | FullImage[] | null
if (viewed !== null && !Array.isArray(viewed)) {
  viewed.depth = 5
  console.log('through depth=' + requireImageRecord(sink).depth + ' original=' + original.depth)
}
