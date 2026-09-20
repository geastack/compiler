import ts from 'typescript'
import type { StructuralTypeId } from '../../identity/ids.js'

/**
 * One step of `structural.ts`'s `typeAt`, keyed by the FORM it serves.
 *
 * `typeAt` was an ordered chain of thirty-nine `if (answer) return answer`
 * steps (a join, not an ordered chain). The order was load-bearing and
 * almost entirely undocumented as order: where two steps can both answer one
 * node, whichever was written first wins, and that precedence is the answer --
 * not a tie-break over two answers that agree. `collection` before `bag` is a
 * commented choice; `field` versus `collection` for one declaration is never
 * cross-checked at all. A chain like that cannot be extended by adding a row,
 * which is the whole complaint 4.3 exists to fix: every new form means finding
 * the right place in a sequence whose constraints live in nobody's head.
 *
 * A rule states which forms it serves. The dispatcher selects by form, so a
 * rule that cannot possibly answer for a node is never asked, and two rules
 * claiming one form become VISIBLE -- a disagreement to resolve at its root,
 * rather than a precedence nobody chose.
 *
 * `forms: null` means "any node", which is where the port currently stands for
 * most rules: it does NOT assert that the rule is form-independent, only that
 * its own first test is not a node-kind test and so nobody has yet written
 * down what it answers for. Order still decides among those, exactly as the
 * chain did. Every `forms: null` is a row this phase still owes a form, and
 * counting them is the honest measure of the port.
 */
export interface StructuralRule {
  /** What this rule is called when a disagreement names it. Stable; it is an identifier in reports, not prose. */
  readonly name: string
  /** The syntactic forms this rule answers for, or `null` for a rule that is not keyed by form yet. */
  readonly forms: readonly ts.SyntaxKind[] | null
  /**
   * Must be correct for ANY node, including one outside `forms`.
   *
   * `forms` is a claim the dispatcher acts on and the audit checks -- never the
   * thing that makes a rule right. Deleting a resolver's own kind test because
   * `forms` "already covers it" produces a rule that is correct only while
   * nobody asks it, and the first port to try that
   * (`binding-pattern-is-its-source`) immediately answered for call
   * expressions and string literals under `GEA_STRUCTURAL_FORM_AUDIT`. That is
   * also precisely why the audit can be a gate at all: it asks every rule for
   * every node, so a rule leaning on `forms` for correctness reports itself.
   */
  readonly resolve: (node: ts.Node) => StructuralTypeId | null
}

/** Two rules that both answered for one node, and what each said. */
export interface StructuralDisagreement {
  readonly kind: ts.SyntaxKind
  readonly winner: string
  readonly other: string
  /** Whether the two agreed on the id. An AGREEING pair is still a finding: two authorities that happen to match today. */
  readonly agreed: boolean
}

/**
 * Whether the extra work that finds disagreements runs at all.
 *
 * It is opt-in for a reason this codebase has already paid for once: asking a
 * rule that the chain would have skipped INTERNS structural ids that the
 * compilation never needed, and interning an id nobody needed renumbers every
 * later id -- and with it every `gea_record_type_N` in the emitted C++. The
 * cell-facts agreement instrument renumbered 68 corpus programs exactly that
 * way (`cells/agreement.ts`). An instrument that changes the artifact it
 * measures is not an instrument, so this one runs only when asked for.
 */
export const structuralDisagreementsEnabled = (): boolean => Boolean(process.env['GEA_STRUCTURAL_DISAGREEMENT'])

/** A rule that answered for a node whose form its `forms` does not claim. */
export interface StructuralFormViolation {
  readonly rule: string
  readonly kind: ts.SyntaxKind
}

/**
 * Whether to audit the form keys instead of trusting them.
 *
 * This is the gate for the 4.3 port, and it is the only thing that can be one.
 * A `forms` list is a CLAIM about which nodes a rule can answer for, arrived at
 * by reading the resolver and everything it delegates to; a wrong claim does
 * not fail to compile and does not throw -- it silently stops asking a rule for
 * a whole syntactic form, which is a miscompile that looks like a design.
 *
 * Under audit every rule is asked for every node, in declaration order, which
 * is exactly what the chain did before the port. So the answer is the
 * pre-port answer by construction, and any rule that answers outside its own
 * `forms` is reported. Zero violations over a corpus is the proof that keying
 * changed nothing; one violation names the rule and the form it lied about.
 *
 * Opt-in for the same reason as the disagreement instrument, and more sharply:
 * asking every rule for every node interns ids the compilation never needed.
 * An audit run's emitted C++ must never be compared with anything.
 */
export const structuralFormAuditEnabled = (): boolean => Boolean(process.env['GEA_STRUCTURAL_FORM_AUDIT'])

/** A rule set with its per-form selection already made. */
export interface StructuralRuleSet {
  /** The first answer among the rules that serve this node's form, or `null` if none answered. */
  readonly resolve: (node: ts.Node, record?: (disagreement: StructuralDisagreement) => void) => StructuralTypeId | null
  /** Rules caught answering outside their declared forms. Always empty unless `GEA_STRUCTURAL_FORM_AUDIT` is set. */
  readonly formViolations: readonly StructuralFormViolation[]
}

/**
 * Prepare a rule set for dispatch.
 *
 * The selection is cached per syntax kind rather than recomputed per node, and
 * that is not micro-optimisation: `typeAt` is asked for essentially every node
 * of every source file, so filtering the whole rule list at each call would put
 * an allocation and a linear scan on the hottest path in the normalize stage --
 * the same shape of cost that `geatsc-normalize-stage-quadratic-scans` already
 * cost this compiler 48 seconds once.
 *
 * Order within a form is the order the rules were declared in, which is the
 * order the chain asked them, so preparing changes no answer.
 */
export const prepareStructuralRules = (rules: readonly StructuralRule[]): StructuralRuleSet => {
  // Decided once, when the set is prepared: an audit asks every rule for every
  // node, so the selection below is bypassed rather than rebuilt.
  const auditing = structuralFormAuditEnabled()
  const formViolations: StructuralFormViolation[] = []
  const servingByKind = new Map<ts.SyntaxKind, readonly StructuralRule[]>()
  const servingFor = (kind: ts.SyntaxKind): readonly StructuralRule[] => {
    if (auditing) return rules
    const known = servingByKind.get(kind)
    if (known) return known
    const serving = rules.filter((rule) => rule.forms === null || rule.forms.includes(kind))
    servingByKind.set(kind, serving)
    return serving
  }
  return {
    // `record` collects what the rules AFTER the winner would have said, so a
    // disagreement is visible as a disagreement. It is opt-in because asking a
    // rule the chain would have skipped mints ids nobody needed -- see
    // `structuralDisagreementsEnabled`.
    resolve: (node, record) => {
      let answer: StructuralTypeId | null = null
      let winner = ''
      for (const rule of servingFor(node.kind)) {
        const resolved = rule.resolve(node)
        if (resolved === null) continue
        // Recorded whether or not this rule WON: a rule that answers outside
        // its forms is a false claim even when an earlier rule would have
        // shadowed it today, because the next reordering makes it the answer.
        if (auditing && rule.forms !== null && !rule.forms.includes(node.kind)) {
          formViolations.push({ rule: rule.name, kind: node.kind })
        }
        if (answer === null) {
          answer = resolved
          winner = rule.name
          if (!record && !auditing) return answer
          continue
        }
        record?.({ kind: node.kind, winner, other: rule.name, agreed: resolved === answer })
      }
      return answer
    },
    formViolations
  }
}
