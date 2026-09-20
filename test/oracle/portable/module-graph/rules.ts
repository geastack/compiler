import { issue } from './ledger.js'

export interface Job {
  name: string
  priority: number
  tags: string[]
}

export function scoreJob(job: Job): number {
  const urgent = job.tags.indexOf('urgent') >= 0 ? 5 : 0
  const batch = job.tags.indexOf('batch') >= 0 ? 2 : 0
  return job.priority * 3 + urgent + batch
}

export function runBatch(jobs: Job[]): string {
  const out: string[] = []
  for (const job of jobs) out.push(issue(job.name) + ':' + String(scoreJob(job)))
  return out.join('|')
}
