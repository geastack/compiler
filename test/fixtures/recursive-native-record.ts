/** A named record keeps its existing nominal native-reference indirection. */
export interface RecursiveRecord {
  value: number
  next: RecursiveRecord | null
}

export const readRecursiveRecord = (record: RecursiveRecord): number => (record.next === null ? record.value : record.next.value)
