import { Tint } from './group.js'

// The shape of `@types/three`'s `ColorManagement.d.ts`: an exported const
// whose type is an interface of the same name.
/** Plain data, declared only here: inlined wherever the overlay may state it. */
interface Space {
  toXYZ: number
  name?: string
}

export interface Palette {
  enabled: boolean
  convert: (color: Tint, from: string, to: string) => Tint
  scale(factor: number): number
  define: (spaces: Record<string, Space>, fallback: Space) => void
}

export const Palette: Palette
