export class Base {
  constructor() {
    this.name = ''
  }
  fromJSON(json) {
    if (json.combine !== undefined) this.combine = json.combine
    return this
  }
}
