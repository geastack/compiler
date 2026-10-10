// ECMA-262 22.1.3.15 String.prototype.normalize over UAX #15. A database
// client's password normalizer NFKC-normalizes a SCRAM password before hashing it, so
// the compatibility forms matter as much as the canonical ones.

const hex = (s: string): string => Array.from(s, (c) => c.codePointAt(0)!.toString(16)).join(' ')
const forms = ['NFC', 'NFD', 'NFKC', 'NFKD']
const samples = ['Amélie', 'Amélie', 'ẛ̣', 'ﬁanceⅨ', 'ÅΩ', '한글', '한', 'x̣̂y', 'ཱཱིུ', 'ｶﾞ', 'café ²']
//! expect: NFC=41 6d e9 6c 69 65 | NFD=41 6d 65 301 6c 69 65 | NFKC=41 6d e9 6c 69 65 | NFKD=41 6d 65 301 6c 69 65
//! expect: NFC=41 6d e9 6c 69 65 | NFD=41 6d 65 301 6c 69 65 | NFKC=41 6d e9 6c 69 65 | NFKD=41 6d 65 301 6c 69 65
//! expect: NFC=1e9b 323 | NFD=17f 323 307 | NFKC=1e69 | NFKD=73 323 307
//! expect: NFC=fb01 61 6e 63 65 2168 | NFD=fb01 61 6e 63 65 2168 | NFKC=66 69 61 6e 63 65 49 58 | NFKD=66 69 61 6e 63 65 49 58
//! expect: NFC=c5 3a9 | NFD=41 30a 3a9 | NFKC=c5 3a9 | NFKD=41 30a 3a9
//! expect: NFC=d55c ae00 | NFD=1112 1161 11ab 1100 1173 11af | NFKC=d55c ae00 | NFKD=1112 1161 11ab 1100 1173 11af
//! expect: NFC=d55c | NFD=1112 1161 11ab | NFKC=d55c | NFKD=1112 1161 11ab
//! expect: NFC=78 323 302 79 | NFD=78 323 302 79 | NFKC=78 323 302 79 | NFKD=78 323 302 79
//! expect: NFC=f71 f71 f72 f74 | NFD=f71 f71 f72 f74 | NFKC=f71 f71 f72 f74 | NFKD=f71 f71 f72 f74
//! expect: NFC=ff76 ff9e | NFD=ff76 ff9e | NFKC=30ac | NFKD=30ab 3099
//! expect: NFC=63 61 66 e9 a0 b2 | NFD=63 61 66 65 301 a0 b2 | NFKC=63 61 66 e9 20 32 | NFKD=63 61 66 65 301 20 32
for (const sample of samples) {
  const answers: string[] = []
  for (const form of forms) answers.push(form + '=' + hex(sample.normalize(form)))
  console.log(answers.join(' | '))
}
//! expect: default=e9
console.log('default=' + hex('é'.normalize()))
//! expect: ascii=plain
console.log('ascii=' + 'plain'.normalize('NFKC'))
try {
  'x'.normalize('NFX')
} catch (error) {
  //! expect: RangeError
  console.log((error as Error).name)
}
