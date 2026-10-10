import { withoutSpecialization } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'

export const SIBLING_CLASS_ARGUMENT = 'native:sibling-class-argument'

/** Physical copies share source identity, but never a native object layout. */
export const siblingClassArgumentOf = (source: Representation, target: Representation): boolean =>
  source.kind === 'class-ref' &&
  target.kind === 'class-ref' &&
  source.declaration !== target.declaration &&
  [source.declaration, ...source.ancestors].some(
    (declaration) => declaration !== target.declaration && withoutSpecialization(declaration) === withoutSpecialization(target.declaration)
  )
