/** Declared only here, and its method makes it no JSDoc object type: `group.js` exports nothing by this name. */
export interface Group {
  start: number
  split(at: number): Group
}

/** Declared only here, but plain data -- spelled out inline where it is used. */
export interface Range {
  start: number
  count: number
}

export declare class Tint {
  value: number
}
