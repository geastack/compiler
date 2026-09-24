import { scale } from './vendor/loose-lib/src/scale.js'
import { deep } from './vendor/loose-lib/src/nested/deep.js'
import { other } from './vendor/loose-lib/extra/other.js'
import { strictScale } from './vendor/strict-lib/src/scale.js'

// `scale`'s JSDoc still types it: `@returns {number}` is read from an
// unchecked file, so this line is an error in the checked entry.
const text: string = scale(2)

console.log(text, deep('x'), other(1), strictScale(4))
