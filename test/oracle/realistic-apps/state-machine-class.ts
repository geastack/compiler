//! oracle: node
class TrafficLight {
  state: string = 'red'
  ticks: number = 0
  tick(): string {
    this.ticks += 1
    if (this.state === 'red') this.state = 'green'
    else if (this.state === 'green') this.state = 'yellow'
    else this.state = 'red'
    return this.state
  }
}
export function main(): string {
  const light = new TrafficLight()
  const seq: string[] = []
  for (let i = 0; i < 7; i++) seq.push(light.tick())
  return 'seq=' + seq.join('->') + ' ticks=' + light.ticks
}
console.log(main())
