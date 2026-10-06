//! expect: a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p
//! expect: a,c,d,e,f,g,h,i,j,l,m,n,o,p
//! expect: a,d,e,f,g,h,i,j,l,n,o,p
//! expect: a,d,e,f,g,h,i,j,l,n,o,p,c,m
//! expect: 1 30 9 130
//! expect: true a,d,e,f,g,h,i,j,l,n,o,p,c,m
//! expect: false 1
//! expect: 1,2,z,a,b,c,d,e,f,g
//! expect: a,b,c,d,e,f,g,h,i
//! expect: a,b,c,d,e,f,g,h
//! expect: a,b,d,e,f,g,h
//! expect: a,b,d,e,f,g,h,c
//! emitted-has: NativeStringFieldMetadata<
//! emitted-has: appendNativeStringFieldKeys(*this,
//! emitted-has: appendNativeEnumerableStringFieldKeys(*this,

class MetadataBase {
  a = 1
  b = 2
  c = 3
  d = 4
  e = 5
  f = 6
  g = 7
  h = 8
}

class MetadataDerived extends MetadataBase {
  i = 9
  j = 10
  k = 11
  l = 12
  m = 13
  n = 14
  o = 15
  p = 16
}

const fields = new MetadataDerived()
const reflected: any = fields
console.log(Object.keys(fields).join(','))
Object.defineProperty(reflected, 'b', { enumerable: false })
Object.defineProperty(reflected, 'k', { enumerable: false })
console.log(Object.keys(fields).join(','))
delete reflected.c
delete reflected.m
console.log(Object.keys(fields).join(','))
reflected.c = 30
reflected.m = 130
console.log(Object.keys(fields).join(','))
console.log(fields.a, fields.c, fields.i, fields.m)
Object.freeze(fields)
console.log(Object.isFrozen(fields), Object.keys(fields).join(','))
console.log(Reflect.deleteProperty(reflected, 'a'), fields.a)

const numeric = { z: 1, a: 2, b: 3, c: 4, d: 5, e: 6, f: 7, g: 8, '2': 9, '1': 10 }
console.log(Object.keys(numeric).join(','))

const accessor = {
  a: 1,
  b: 2,
  c: 3,
  d: 4,
  get e() {
    return 5
  },
  f: 6,
  g: 7,
  h: 8,
  i: 9
}
console.log(Object.keys(accessor).join(','))

const deletedRecord: any = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 }
console.log(Object.keys(deletedRecord).join(','))
delete deletedRecord.c
console.log(Object.keys(deletedRecord).join(','))
deletedRecord.c = 30
console.log(Object.keys(deletedRecord).join(','))
