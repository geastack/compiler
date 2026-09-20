// The DEPENDENCY half of `top-level-await-import.ts`: a module whose exports
// are not ready until its own top-level `await` resolves. Run standalone by
// the harness too (every `.ts` here is a program), where it must simply work.
export const trace: string[] = []

const ready = async (n: number): Promise<string> => (n > 0 ? 'ready' : 'not')

export const value = await ready(1)
trace.push('dep')
