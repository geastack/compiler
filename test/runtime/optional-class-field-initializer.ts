class Queue {
  private values?: string[] = []

  add(value: string): string {
    if (!this.values) throw new Error('initialized optional field is absent')
    this.values.push(value)
    return this.values.join(',')
  }
}

console.log(new Queue().add('ready'))
