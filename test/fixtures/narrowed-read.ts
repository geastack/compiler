// A cell and a read of it that the checker types differently.
//
// `label` holds `Optional<string>` because that is what the declaration binds,
// and inside `if (label)` the checker types the read `string`. The two carriers
// disagree, and the load that resolves them -- `gea::Optional::operator*` -- is
// the narrowing conversion `targets/cpp/conversions.ts` installs. This fixture
// exists so that capability is proven by emitted, compiling C++ rather than
// asserted by a registry entry.
export const label: string | undefined = 'left'

export function labelOrDefault(): string {
  if (label) return label
  return 'none'
}

// Called at module scope so the body is emitted rather than shaken away.
export const probe = labelOrDefault()
