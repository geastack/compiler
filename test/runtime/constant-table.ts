//! expect: march=31
//! expect: total=365
//! emitted-has: static const double gea_table_
//! emitted-has: appendTable(
// A literal of constants is a static table from a handful of elements on, not
// only from sixty-four (`emit-arrays.ts`'s `constantTableThreshold`): a
// twelve-entry month table is one copy out of `.rodata`, not twelve pushes.
const daysInMonth = (month: number): number => {
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  let total = 0
  for (let i = 0; i < days.length; i++) total += days[i] ?? 0
  console.log(`total=${total}`)
  return days[month] ?? 0
}
console.log(`march=${daysInMonth(2)}`)
