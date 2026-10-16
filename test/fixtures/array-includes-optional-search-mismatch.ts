const words: string[] = ['1']
function mismatch(value?: number): boolean {
  return words.includes(value as unknown as string)
}
console.log(mismatch(1))
