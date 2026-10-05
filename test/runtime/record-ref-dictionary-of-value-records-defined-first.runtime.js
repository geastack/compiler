// @ts-nocheck
//! expect: position:1:3 normal:2:5 | 1 2 | -1 false
// A record whose field is a shared dictionary of records held BY VALUE
// (`Ref<Dictionary<Optional<Inner>>>`) asks, in its own trace signature,
// whether the dictionary's elements trace -- which instantiates
// `Optional<Inner>` and so needs `Inner` complete. Nothing else about the
// field needs `Inner`, so the outer struct used to be emitted first. three's
// `NodeMaterialObserver.getGeometryData` builds exactly this shape.
class Attribute {
  constructor(id, version) {
    this.id = id
    this.version = version
  }
}
class Geometry {
  constructor() {
    this.attributes = {}
    this.drawRange = { start: 1, count: 2 }
  }
  setAttribute(name, attribute) {
    this.attributes[name] = attribute
    return this
  }
}
class Observer {
  getAttributesData(attributes) {
    const attributesData = {}
    for (const name in attributes) {
      const attribute = attributes[name]
      attributesData[name] = { id: attribute.id, version: attribute.version }
    }
    return attributesData
  }
  getGeometryData(geometry) {
    return {
      _renderId: -1,
      _equal: false,
      attributes: this.getAttributesData(geometry.attributes),
      // Only numbers this shape past the dictionary's element shape, so the
      // outer name sorts first (`..._109` before `..._32`) as three's did.
      padding: [
        { p1: 1 },
        { p2: 2 },
        { p3: 3 },
        { p4: 4 },
        { p5: 5 },
        { p6: 6 },
        { p7: 7 },
        { p8: 8 },
        { p9: 9 },
        { p10: 10 },
        { p11: 11 },
        { p12: 12 },
        { p13: 13 },
        { p14: 14 },
        { p15: 15 },
        { p16: 16 },
        { p17: 17 },
        { p18: 18 },
        { p19: 19 },
        { p20: 20 },
        { p21: 21 },
        { p22: 22 },
        { p23: 23 },
        { p24: 24 },
        { p25: 25 },
        { p26: 26 },
        { p27: 27 },
        { p28: 28 },
        { p29: 29 },
        { p30: 30 },
        { p31: 31 },
        { p32: 32 },
        { p33: 33 },
        { p34: 34 },
        { p35: 35 },
        { p36: 36 },
        { p37: 37 },
        { p38: 38 },
        { p39: 39 },
        { p40: 40 },
        { p41: 41 },
        { p42: 42 },
        { p43: 43 },
        { p44: 44 },
        { p45: 45 },
        { p46: 46 },
        { p47: 47 },
        { p48: 48 },
        { p49: 49 },
        { p50: 50 }
      ],
      drawRange: { start: geometry.drawRange.start, count: geometry.drawRange.count }
    }
  }
}
const geometry = new Geometry().setAttribute('position', new Attribute(1, 3)).setAttribute('normal', new Attribute(2, 5))
const data = new Observer().getGeometryData(geometry)
const parts = []
for (const name in data.attributes) parts.push(name + ':' + data.attributes[name].id + ':' + data.attributes[name].version)
console.log(parts.join(' '), '|', data.drawRange.start, data.drawRange.count, '|', data._renderId, data._equal)
