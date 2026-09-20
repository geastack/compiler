class ValidationError extends Error {
  field: string

  constructor(field: string, message: string) {
    super(message)
    this.name = 'ValidationError'
    this.field = field
  }
}

interface FormInput {
  id: string
  amount: number
  code: string
}

function validate(input: FormInput, log: string[]): string {
  try {
    if (input.amount <= 0) throw new ValidationError('amount', 'must be positive')
    if (!/^[A-Z]{2}[0-9]{2}$/.test(input.code)) throw new ValidationError('code', 'bad format')
    return 'ok:' + input.id + ':' + input.amount
  } catch (error: unknown) {
    if (error instanceof ValidationError) {
      return 'invalid:' + error.field + ':' + error.message
    }
    if (error instanceof Error) {
      return 'error:' + error.name + ':' + error.message
    }
    return 'unknown:' + String(error)
  } finally {
    log.push('checked:' + input.id)
  }
}

export function main(): string {
  const log: string[] = []
  const inputs: FormInput[] = [
    { id: 'a', amount: 3, code: 'AB12' },
    { id: 'b', amount: 0, code: 'CD34' },
    { id: 'c', amount: 7, code: 'bad' }
  ]
  const results = inputs.map((input) => validate(input, log))
  return results.join('|') + ' log=' + log.join(',')
}

console.log(main())
