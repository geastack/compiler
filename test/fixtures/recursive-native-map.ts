/** The map's value is the same native wrapper, not a boxed dynamic value. */
export type RecursiveMap = Map<string, RecursiveMap>

export const recursiveMap: RecursiveMap = new Map()
