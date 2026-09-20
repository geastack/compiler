type PixelSource = {
  width?: number
  height?: number
  depth?: number
}

class SourceData {
  data: PixelSource | PixelSource[] | null

  constructor(data: PixelSource | PixelSource[] | null = null) {
    this.data = data
  }
}

class TextureData {
  source: SourceData

  constructor(image: PixelSource | PixelSource[] | null | undefined = null) {
    this.source = new SourceData(image)
  }
}

//! expect: true
console.log(new TextureData(null).source.data === null)
