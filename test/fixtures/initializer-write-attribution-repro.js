class Widget {
  constructor() {
    this.count = 0
  }

  /**
   * Never called from anywhere in this program. `reachable.memberIsPruned`
   * correctly marks it dead, so `flow/value-flow.ts`'s indexer records zero
   * writes for anything inside it -- there is nothing to record, since the
   * body never runs. `usageCount`'s declaration still SYNTACTICALLY has an
   * initializer, which used to be enough for `local-bindings.ts`'s own
   * candidate walk to treat it as live evidence to explain, manufacturing a
   * `no-writes:initializer-unseen` refusal for code that was never reached in
   * the first place.
   *
   * @param {*} builder
   */
  unused(builder) {
    const usageCount = builder.increaseUsage(this)

    if (usageCount === 1) {
      this.count = usageCount
    }

    return usageCount
  }
}

const w = new Widget()
console.log(w.count)
