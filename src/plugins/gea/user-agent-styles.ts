/**
 * gea's user-agent stylesheet.
 *
 * The engine has no default stylesheet. `Document::createElement(tag)`
 * (`core/packages/engine/ui/document.cpp`) maps a handful of tags to typed
 * creators, stamps the tag name, and stops -- so a `<p>` and a `<div>` reach
 * layout with byte-identical style state. Everything a browser's UA sheet would
 * say about a tag has to be said by somebody else, and in v1 that somebody is
 * the compiler: `intrinsicStyleLines` in the gea plugin's
 * `cpp-template-renderer.ts` emits `Tree::setDefaultStyle` calls next to the
 * node it just built.
 *
 * v2 emitted none of them, and the visible result was the `typography` app's
 * intro paragraph: `<p>` + three `<span>`s rendered as narrow columns of one
 * character each instead of a line of prose. The stylesheet was NOT the
 * difference -- `gea-style-registration.cppfrag` is produced by the shared
 * build pipeline and is byte-identical between the two compilers -- and neither
 * were the tags: v2 spells `gea::jsx::create<NodeHandle>("span")` and the
 * engine's `isInlineLevelTag` recognises it. What was missing was one bit.
 *
 * `LayoutNodePass::resolveRowDirection` (`ui/layout.cpp`) already builds the
 * inline formatting context: a plain block whose in-flow children are all
 * inline-level flows them on a ROW, the way CSS says. But the row it hands to
 * `FlexLayoutPass` is only allowed to break into lines when
 * `node.style.flex_wrap` is set, and nothing sets it -- so every inline run
 * landed on one unbreakable line, each item shrunk to a sliver. v1 never sees
 * this because it writes `display:flex / flex-direction:row / flex-wrap:wrap`
 * onto exactly those containers. `flex-wrap` is the whole of the fix; the other
 * two only restate what `resolveRowDirection` already worked out, and stating
 * `display:flex` here would be actively wrong -- it would make a `<span>`
 * non-inline-level (`isInlineLevelNode` rejects a flex node), which is the one
 * thing that would stop its parent forming an inline row at all.
 *
 * Expressed as CSS rather than as per-node default styles because that is what
 * it is -- and because the cascade already ranks it correctly. The engine
 * implements real specificity (`computeRuleSpecificity`, `ui/style.cpp`: id
 * 10000 / class 100 / element 1, ties by source order), so an element-selector
 * rule registered before the app's own tape loses to every class rule the app
 * writes and to the app's own element rules. That is the same "lowest priority,
 * overridable by anything the author says" tier `setDefaultStyle` occupies in
 * v1, without the compiler having to reach into a node it did not build.
 *
 * The tag set and the heading sizes are v1's, verbatim (`isTextNodeTag` and
 * `headingDefaultFontSize`), because the two compilers have to put the same
 * pixels on the same panel.
 */
const inlineContainerTags = ['p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const

/** v1's `headingDefaultFontSize`, in px. */
const headingFontSizes: readonly (readonly [string, number])[] = [
  ['h1', 34],
  ['h2', 28],
  ['h3', 24],
  ['h4', 20],
  ['h5', 18],
  ['h6', 16]
]

const cppTagList = (tags: readonly string[]): string => tags.map((tag) => `"${tag}"`).join(', ')

const cppHeadingList = (sizes: readonly (readonly [string, number])[]): string =>
  sizes.map(([tag, size]) => `{"${tag}", ${size}}`).join(', ')

/**
 * The registration block, as one C++ statement block.
 *
 * A block rather than a free function so it can be dropped into either prelude
 * form -- the static-initialization object a single-app binary gets, or the
 * named `<prefix>_register_styles()` a resident build calls when its app
 * starts -- without either form having to know what is in it.
 */
export const geaUserAgentStyleSheet: string = [
  '// gea user-agent defaults: the tag-driven styles the engine has no sheet for.',
  "// Registered BEFORE the app's own rules so equal-specificity ties go to the app.",
  '{',
  '  namespace __gea_ua_ns = gea::embedded::ui;',
  '  auto &__gea_ua_sheet = __gea_ua_ns::StyleSheet::instance();',
  '  __gea_ua_sheet.beginRuleRegistrationBatch();',
  '  // An inline formatting context wraps. `resolveRowDirection` (ui/layout.cpp)',
  '  // already flows an all-inline block on a row; without this the row cannot',
  '  // break, and a paragraph of text and spans renders as slivered columns.',
  `  static const char *const __gea_ua_inline_tags[] = {${cppTagList(inlineContainerTags)}};`,
  '  for (const char *const __gea_ua_tag : __gea_ua_inline_tags) {',
  '    __gea_ua_sheet.registerStaticPropertyRule(',
  '      __gea_ua_ns::StaticStyleSelectorKind::Element, __gea_ua_tag, __gea_ua_ns::Property::FlexWrap, 1);',
  '  }',
  "  // Heading sizes, v1's `headingDefaultFontSize` verbatim.",
  '  static const struct { const char *tag; float size; } __gea_ua_headings[] = {',
  `    ${cppHeadingList(headingFontSizes)}`,
  '  };',
  '  for (const auto &__gea_ua_heading : __gea_ua_headings) {',
  '    __gea_ua_sheet.registerStaticLengthRule(',
  '      __gea_ua_ns::StaticStyleSelectorKind::Element, __gea_ua_heading.tag,',
  '      __gea_ua_ns::StaticStyleLengthProperty::FontSize, __gea_ua_ns::StaticStyleLengthUnit::Px,',
  '      __gea_ua_heading.size);',
  '  }',
  '  __gea_ua_sheet.endRuleRegistrationBatch();',
  '}'
].join('\n')
