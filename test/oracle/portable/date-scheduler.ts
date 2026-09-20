//! oracle-expect: 00:00:boot|00:15:calibrate|00:30:sweep|minutes=45|first=1609459200000
interface ScheduledEvent {
  name: string
  at: Date
  durationMinutes: number
}

function event(name: string, offsetMinutes: number, durationMinutes: number): ScheduledEvent {
  const startOfDay = 1609459200000
  return {
    name,
    at: new Date(startOfDay + offsetMinutes * 60_000),
    durationMinutes
  }
}

function renderTime(date: Date): string {
  return date.toISOString().slice(11, 16)
}

function renderTimeline(events: ScheduledEvent[]): string {
  events.sort((a, b) => a.at.getTime() - b.at.getTime())
  let total = 0
  const out: string[] = []
  for (const item of events) {
    total += item.durationMinutes
    out.push(renderTime(item.at) + ':' + item.name)
  }
  return out.join('|') + '|minutes=' + String(total) + '|first=' + String(events[0].at.getTime())
}

export function main(): string {
  return renderTimeline([event('calibrate', 15, 20), event('boot', 0, 15), event('sweep', 30, 10)])
}

console.log(main())
