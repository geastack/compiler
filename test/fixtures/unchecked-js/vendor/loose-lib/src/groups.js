export class Group {
  constructor(name) {
    this.name = name
  }
}

export class Groups {
  constructor() {
    /** @type {Object<string,Object<string,Group>>} */
    this.byName = {}
    /** @type {Object<string,Group>} */
    this.stated = {}
    /** @type {Group} */
    this.current = null
    /** @type {Object<string,Group>} */
    this.loose = {}
  }
  get(name, value) {
    let group = this.byName[name]
    if (group === undefined) {
      group = new Group(name)
      this.byName[name] = group
    }
    this.stated[name] = group
    this.loose[name] = value
    this.current = group
    return group
  }
}
