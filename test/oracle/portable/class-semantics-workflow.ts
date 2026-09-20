class Claim {
  constructor(
    readonly id: string,
    readonly priority: number,
    readonly tags: string[],
    readonly amount: number
  ) {}
}

class Rule {
  static #issued = 0
  static readonly family = 'risk'

  readonly serial: number
  #weight: number

  constructor(
    readonly name: string,
    weight: number
  ) {
    Rule.#issued += 1
    this.serial = Rule.#issued
    this.#weight = weight
  }

  static get issued(): number {
    return Rule.#issued
  }

  get weight(): number {
    return this.#weight
  }

  set weight(value: number) {
    this.#weight = value < 0 ? 0 : value
  }

  get label(): string {
    return Rule.family + ':' + this.name + ':' + String(this.serial)
  }

  protected baseScore(claim: Claim): number {
    return claim.priority + this.weight
  }

  score(claim: Claim): number {
    return this.baseScore(claim)
  }
}

class EscalationRule extends Rule {
  static #urgentBoost = 2
  #threshold: number

  constructor(name: string, weight: number, threshold: number) {
    super(name, weight)
    this.#threshold = threshold
  }

  static tuneUrgency(boost: number): void {
    EscalationRule.#urgentBoost = boost
  }

  get threshold(): number {
    return this.#threshold
  }

  set threshold(value: number) {
    this.#threshold = value < 0 ? 0 : value
  }

  override get label(): string {
    return super.label + ':escalate>' + String(this.threshold)
  }

  protected override baseScore(claim: Claim): number {
    const inherited = super.baseScore(claim)
    const urgent = claim.tags.indexOf('urgent') >= 0 ? EscalationRule.#urgentBoost : 0
    const large = claim.amount >= this.threshold ? 3 : 0
    return inherited + urgent + large
  }
}

class ReviewRule extends Rule {
  #floor: number

  constructor(name: string, weight: number, floor: number) {
    super(name, weight)
    this.#floor = floor
  }

  get floor(): number {
    return this.#floor
  }

  set floor(value: number) {
    this.#floor = value < 0 ? 0 : value
  }

  override get label(): string {
    return super.label + ':review>=' + String(this.floor)
  }

  override score(claim: Claim): number {
    const inherited = super.score(claim)
    return inherited < this.floor ? this.floor : inherited
  }
}

function evaluate(rule: Rule, claim: Claim): string {
  return rule.label + '=' + String(rule.score(claim))
}

export function main(): string {
  EscalationRule.tuneUrgency(4)
  const claims: Claim[] = [new Claim('A', 3, ['urgent', 'card'], 900), new Claim('B', 8, ['audit'], 120)]

  const escalation = new EscalationRule('chargeback', 2, 500)
  const review = new ReviewRule('manual', 1, 10)
  review.weight = -5
  review.floor = 9
  escalation.threshold = 700

  const first = evaluate(escalation, claims[0])
  const second = evaluate(review, claims[1])
  const inheritance = escalation instanceof Rule && escalation instanceof EscalationRule
  return first + '|' + second + '|issued=' + String(Rule.issued) + '|inheritance=' + String(inheritance)
}

console.log(main())
