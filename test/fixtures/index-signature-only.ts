// A declared index signature is a *type-level* parameter list: `[key: string]`
// looks like a one-parameter signature and is not one, because nothing ever
// calls it and no caller ever writes an argument slot for it. Declaring one --
// and never instantiating, referencing, or reading it -- must leave the
// enclosing body's calling convention exactly as it was.
export interface StringCounts {
  [key: string]: number
}

export const marker = 0
