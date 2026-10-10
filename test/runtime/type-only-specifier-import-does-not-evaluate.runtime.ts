// An import whose every specifier is `type` is erased by TypeScript (absent
// `verbatimModuleSyntax`), so its module never evaluates through it: a
// database client's `import { type Cipher } from 'encryption-plugin'`
// requires nothing in the shipped JavaScript. Counting it as an evaluation edge
// ran the helper's top level.
import { type Shape, type Square } from './_type-only-specifier-import-module'

const describe = (shape: Shape): string => `side ${shape.side}`
const fake: Pick<Square, 'side'> = { side: 3 }
console.log(describe(fake))

//! expect: side 3
//! emitted-lacks: helper module evaluated
