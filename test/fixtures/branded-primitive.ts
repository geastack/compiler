// Branded primitives: `T & { brand?: never }`. The brand is a type-system-only
// marker -- an optional property of type `never` can never actually be
// assigned, so it constrains nothing at runtime -- and the intersection must
// reduce to the branded member's own carrier, exactly as `type f32 = number &
// { readonly [__gea_f32_brand]?: never }` does in the framework's own `.d.ts`
// (core/packages/core/index.d.ts). That real brand is symbol-keyed; this one
// is string-keyed so the fixture does not also need a `unique symbol`
// binding's own carrier (symbols have none, by design, and that is an
// unrelated, pre-existing gap) -- the key's kind makes no difference to the
// collapse below, only whether the member is optional and reads as absent.

export type F32 = number & { readonly __brand?: never }

export const half = (value: F32): F32 => (value / 2) as F32

// A non-primitive substantive member must also survive branding: the brand
// contributes no structure, so the class keeps its own carrier rather than
// being merged into a record and losing its identity.
export class Meters {
  constructor(readonly value: number) {}
}

export type BrandedMeters = Meters & { readonly __brand?: never }

export const describe = (value: BrandedMeters): number => value.value
