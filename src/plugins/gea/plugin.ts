import type { DeclarationId, OperationId } from '../../identity/ids.js'
import type { CompilerPlugin, PluginInstance, PluginOptions } from '../model.js'
import type { GeaElementFacts } from './contract.js'
import { geaAfterRenderMemberName, geaRenderBridgeMemberName, geaRenderMemberName } from './contract.js'
import { createGeaComponentClassProducer, type GeaReactiveFields } from './component-classes.js'
import { geaHostConstructors } from './constructors.js'
import {
  geaElementFragment,
  geaElementTextLeafTags,
  geaHostConstants,
  geaHostFunctions,
  geaHostNamespaceMethods,
  geaHostNamespaceProperties,
  geaHostNamespacePropertySetters,
  geaHostNamespaceRoots,
  geaHostNamespaceRootTypes,
  geaHostPreambles,
  geaNativeProtocols,
  geaHostSingletons,
  geaEmbeddedIncludeGuard,
  geaProtocolCarriers
} from './host.js'
import { geaHostMemberVoidResults, geaHostMembers } from './members.js'
import { lowerGeaElement } from './lower.js'
import { createGeaSlotHook } from './slots.js'
import { lowerGeaElementRef } from './element-ref.js'
import { createGeaElementProducer } from './producer.js'
import { geaCppPrelude, microtasksNamespace } from './prelude.js'
import { lowerGeaRenderBridge } from './render-bridge.js'
import { geaComponentInlineTransform } from './component-inline.js'
import { geaReactiveSlotTransform } from './reactive-slots.js'

/**
 * gea, as a plugin.
 *
 * Everything this library adds to TypeScript lives behind this one object: what
 * an element whose tag names a value means, which member of a constructed
 * component produces its tree, and the runtime rows that make those claims
 * checkable. Nothing in `src/` outside this directory knows any of it.
 *
 * The facts map is the whole of the state, and it is per-compilation by
 * construction: `instantiate` creates it, the producer fills it while
 * normalizing one program, and the lowering reads it while lowering that same
 * program. A registry of long-lived instances would let a fact derived from one
 * program be read back while compiling another -- a defect that reproduces only
 * in whatever order the programs happened to be compiled in.
 *
 * `componentClasses` is the same shape of state for a different question:
 * which class *declarations*, not which JSX elements, are gea's own. Both are
 * filled while normalizing and read only while lowering, for the identical
 * reason -- see `component-classes.ts` and `render-bridge.ts`.
 */
export const geaPlugin: CompilerPlugin = {
  name: 'gea',
  instantiate: (options: PluginOptions): PluginInstance => {
    const facts = new Map<OperationId, GeaElementFacts>()
    const componentClasses = new Set<DeclarationId>()
    const reactiveFields: GeaReactiveFields = new Map()
    return {
      producers: (context) => [
        createGeaElementProducer(context, facts),
        createGeaComponentClassProducer(context, componentClasses, reactiveFields)
      ],
      // Two rewrites, in this order, and the order is the point.
      //
      // A component invocation whose props only ever write PROPERTIES becomes
      // the element it builds (`component-inline.ts`), so what follows sees an
      // intrinsic element and binds each attribute at its own granularity
      // rather than making the whole subtree re-runnable. An invocation it
      // cannot prove that of is left exactly as written, and the second rewrite
      // claims it whole as before.
      //
      // Then a JSX slot whose value is COMPUTED gets an immediately-invoked
      // arrow around it, before the checker, so the expression exists as a
      // thunk this compiler can re-run. See `reactive-slots.ts`.
      transformSource: (input) => {
        const inlined = geaComponentInlineTransform(input)
        const source = inlined === null ? input : { fileName: input.fileName, text: inlined }
        return geaReactiveSlotTransform(source) ?? inlined
      },
      lower: (ctx, block, operation) =>
        lowerGeaElement(ctx, block, operation, facts) || lowerGeaRenderBridge(ctx, block, operation, componentClasses),
      // `ref` is the one attribute of an intrinsic element whose meaning runs
      // the other way -- it names where the node goes. See `element-ref.ts`.
      lowerElementProp: lowerGeaElementRef,
      slotOf: createGeaSlotHook(facts),
      capabilities: {
        // `element:value` is this plugin's recipe, and it is claimed here
        // because this plugin is what implements it: the lowering above turns
        // such an element into a record allocation plus a call, or into a
        // construction plus a call of the render member. Both are built from
        // primitives the backend already claims -- nothing new is emitted, so
        // nothing new is asserted about the backend.
        // `element:fragment` joins it whenever the package still ships the
        // document's own fragment row -- see `geaElementFragment`. Claimed
        // from the same statement that renders it, so a package that drops
        // the row drops the claim in the same step.
        runtimeHelpers: new Set<string>(geaElementFragment() === null ? ['element:value'] : ['element:value', 'element:fragment']),
        propertyRecipes: new Set<string>(),
        // The host object model gea installs -- the document, the element tree,
        // JSX. None of it is TypeScript, so none of it is the backend's to
        // know; `host.ts` states each protocol together with the spelling that
        // renders it.
        nativeProtocols: geaNativeProtocols,
        // The host types themselves, from the package that implements them,
        // plus the one carrier that is derived rather than stated:
        // `jsx-element@1` has no TypeScript declaration behind it (JSX is a
        // language form whose meaning the host decides, not a type a host
        // declares), so its row is read off the package's own `Element`
        // spelling -- see `geaProtocolCarriers`.
        nativeTypes: geaProtocolCarriers(),
        // gea's own host types are, like Apple's, ambient declarations with
        // no OTHER, structurally-unrelated ambient name standing in for them
        // -- see `plugins/model.ts`'s `ambientTypeRealizations` and
        // `webgl/plugin.ts` for the host this closes a gap for.
        ambientTypeRealizations: new Map(),
        hostMembers: geaHostMembers(),
        hostMemberVoidResults: geaHostMemberVoidResults(),
        // gea's document/element tree is reached, never constructed -- a
        // program gets its nodes from the runtime rather than by `new`-ing one.
        // But a handful of gea's OTHER host classes really are built with
        // `new` (`WebSocket`, `RTCPeerConnection`, `MediaStream`,
        // `MediaRecorder`, `AudioContext`, `Audio`), each backed by a real
        // `gea::host` C++ class -- see `geaHostConstructors` (constructors.ts)
        // for the package data this reads and why the tree/class split is not
        // a contradiction.
        hostConstructors: geaHostConstructors(),
        // The host's free functions and the globals that are paths rather than
        // values, from the same package statement as the types above.
        // `requestAnimationFrame` is a function the engine exports;
        // `deviceInfo`, `Display` and `navigator` are namespaces. Neither is
        // an object, and reading either as one is what produced eight
        // `extern` declarations nothing in the engine defines.
        hostFunctions: geaHostFunctions(),
        // This host declares each of its free functions once, so there is no
        // name two of its declarations disagree about and nothing to key by
        // file -- see `PluginCapabilities.hostFunctionsByDeclaration`.
        hostFunctionsByDeclaration: new Map(),
        // The one global this host holds an instance of and reaches by name;
        // derived from the package's own receiverless document table.
        hostSingletons: geaHostSingletons(),
        // Same one-declaration-file reasoning as `hostFunctionsByDeclaration`
        // above: this host's ambient globals are declared once, in one place,
        // so there is no second file for a singleton name to disagree with.
        hostSingletonsByDeclaration: new Map(),
        // gea's engine is the browser's stand-in, not a subset of it: the names
        // it does not implement are simply not declared for a gea program, so
        // there is no ambient contract here to contradict.
        absentGlobals: new Set<string>(),
        hostNamespaces: {
          roots: geaHostNamespaceRoots(),
          typeofs: new Map(),
          methods: geaHostNamespaceMethods(),
          properties: geaHostNamespaceProperties(),
          propertySetters: geaHostNamespacePropertySetters()
        },
        // Same reasoning again: one declaration file, so no namespace root
        // name this host claims can disagree with itself.
        hostNamespaceRootsByDeclaration: new Map(),
        // The type behind each of those roots, from the package's own
        // `hostGlobalObjectTypes` table -- see
        // `PluginCapabilities.hostNamespaceRootTypes`.
        hostNamespaceRootTypes: geaHostNamespaceRootTypes(),
        // What a unit must declare before it may name one of those spellings.
        hostPreambles: geaHostPreambles(),
        // gea's host types are one runtime type wearing thirteen declared
        // names (`NodeHandle`), not a hierarchy, so there is no derivation to
        // state and every handle is exactly as related to every other as the
        // shared carrier already makes it.
        nativeBases: new Map(),
        // gea's carriers are declared by `gea_runtime.h`, which every emitted
        // unit already includes, so this library adds no header of its own.
        nativeIncludes: new Map(),
        // The host's own constants: `audioContext` is a global the engine
        // defines and the program only ever reads.
        nativeConstants: geaHostConstants(),
        // Same one-declaration-file reasoning as `hostFunctionsByDeclaration`:
        // nothing here for a second file to disagree with.
        hostConstantsByDeclaration: new Map(),
        // What the gea engine requires back from a compiled program.
        //
        // `core/packages/core/gea_app_entry.cpp` declares both and defines
        // neither: `Application::frame` calls `generated::drainMicrotasks()`
        // once per frame and `Application::init` calls
        // `gea_cpp_clear_microtasks()` when an app starts. The queue they act
        // on belongs to the program, not the engine, which is why the engine
        // asks rather than implements -- and why a unit that omits them
        // compiles cleanly and then fails at `ld`.
        //
        // The queue is the REACTIVE one. Promises settle synchronously here
        // (`gea::Promise` defers nothing), but the coalescing applies do defer:
        // a list or component rebuild is scheduled once per turn and has to
        // land after the callback that wrote and before layout reads the tree.
        // `Application::frame` calls `drainMicrotasks()` at exactly that point,
        // so that is where the queue drains -- see `detail::microtaskQueue` in
        // `gea_runtime.h`, and the frame-late rows an earlier zero-delay timer
        // produced. `gea_cpp_clear_microtasks()` drops the same queue when an
        // app starts, so a resident switch cannot rebuild the outgoing app's
        // list against the incoming app's tree.
        // What `<>...</>` is on this host, from the package's own document
        // table -- see `PluginCapabilities.elementFragment`.
        elementFragment: geaElementFragment(),
        // The tag list is the package's (`isTextNodeTag`); whether an element's
        // contents are one text run is the compiler's -- see `elementTextTags`.
        elementTextTags: geaElementTextLeafTags(),
        // The members this host's own lowering calls without the program
        // naming them, so `reachability.ts` never drops one: the render bridge
        // rebuilds `instance.render(root, depth)` as a call to the class's own
        // `template` (`render-bridge.ts`), and attaches the mounted tree by
        // calling `onAfterRender` when the class declares it. `render` itself
        // is spelled by every app that mounts a component, but a component
        // whose `render` is reached only through the framework's own mount
        // path is not, so it is stated rather than assumed.
        reachedMemberKeys: new Set([geaRenderMemberName, geaRenderBridgeMemberName, geaAfterRenderMemberName]),
        // Filled by the producer above while this program is normalized, and
        // read by the target after it -- the same shared-by-reference state as
        // `facts` and `componentClasses`, and per-compilation for the same
        // reason. See `PluginCapabilities.reactiveClassFields`.
        reactiveClassFields: reactiveFields,
        // The engine's own reactive cell, named here rather than derived: it
        // is gea's runtime type, so this package is the only thing that knows
        // its name.
        nativeReactiveCell: 'gea::embedded::ui::Signal',
        // ...and the only thing that knows where it is DECLARED. This used to
        // be empty, on the claim that `gea_runtime.h` already carries the cell.
        // It does not: that header forward-declares `gea::embedded::ui::Signal`
        // and says so at the declaration, because `ui/signal.h` is on the
        // include path for an engine build only. A JSX program includes the
        // engine for its own reasons and so never noticed; an ordinary program
        // with a reactive field failed at the field declaration with "implicit
        // instantiation of undefined template", which then cascaded into every
        // conversion touching the class and read as an unrelated inheritance
        // defect.
        //
        // The same guarded block the package states ahead of each of its 331
        // host spellings, taken from `geaHostPreambles` rather than restated,
        // so this compilation has one spelling of the engine include and a unit
        // that carries both gets it once.
        nativeReactiveCellPreamble: geaEmbeddedIncludeGuard(),
        // gea's runtime reaches a unit as `gea_runtime.h`, which the support
        // header states unconditionally for every build because every emitted
        // unit is compiled against it -- it is the CLI's own line, not this
        // plugin's contribution, so there is nothing to add here.
        generatedSupportIncludes: [],
        runtimeDefinitions: [
          // The namespace is the BUILD's to state, not this file's. A resident
          // build links several apps into one binary and gives each its own
          // `gea::framework::app::generated::gea_resident_<id>`, which the
          // generated entry shim forward-declares by exactly that name
          // (`targets/web/generate-resident-entry.mjs`); the pipeline passes it
          // as `gea.microtasks-namespace`, derived from the entry symbol.
          // Hardcoding the unsuffixed namespace defined a symbol no shim ever
          // declares AND defined it four times over -- one undefined reference
          // and one duplicate-symbol error from the same line.
          // Guarded on the same condition that decides whether the queue
          // EXISTS. `gea::jsx::detail`'s coalescing half lives inside
          // `#ifdef GEA_HOST_DECLARED` in `gea_runtime.h` -- it is reached only
          // through `reactiveListApply`/`reactiveNodeApply`, which name the
          // engine's `Signal` in their own signatures and so cannot be declared
          // in a unit that links no engine. A program that names no host
          // spelling emits no host preamble, hence no guard, hence no queue;
          // its body stays empty, which is also the right answer, since a unit
          // with no engine has no list to rebuild.
          {
            text: `namespace ${microtasksNamespace(options)} {\nvoid drainMicrotasks() {\n#ifdef GEA_HOST_DECLARED\n  ::gea::jsx::detail::drainMicrotasks();\n#endif\n}\n}`,
            requires: null
          },
          // Weak, and at global scope, for the reason
          // `core/packages/core/test/test_gea_resident_app_switch_main.cpp`
          // states beside its own declaration: every resident's unit defines
          // this, the engine calls it by the unsuffixed name, and the linker
          // has to collapse the definitions rather than reject them. v1 emits
          // it with the same attribute.
          {
            text: 'void __attribute__((weak)) gea_cpp_clear_microtasks() {\n#ifdef GEA_HOST_DECLARED\n  ::gea::jsx::detail::clearMicrotasks();\n#endif\n}',
            requires: null
          },
          // The engine's other pair of program-side entry points, declared the
          // same way and for the same reason: `core/packages/core/gea_app_entry.cpp`
          // wraps `Application::init` and `Application::frame` in a
          // `FrameCycleCollectionDeferral`, whose whole job is to keep the
          // collector off the stack while a host callback still owns transient
          // references. The queue is the PROGRAM's, so the engine asks and the
          // generated unit answers.
          //
          // `_end` collects rather than only decrementing: the deferral exists
          // to move the safepoint to where the host stack has unwound, and a
          // decrement alone leaves the drained candidates until the next
          // allocation happens to cross the threshold -- one frame of garbage
          // retained per frame. `bad_alloc` is swallowed because the collector
          // runs at scope exit of a host callback that has already returned;
          // propagating there unwinds through the engine's own frame, and the
          // candidates it could not trace are still queued for the next
          // safepoint.
          //
          // Weak, at global scope, exactly as `gea_cpp_clear_microtasks` above:
          // a resident build links several apps into one binary and the linker
          // has to collapse the definitions rather than reject them.
          {
            text: 'extern "C" void __attribute__((weak)) gea_cycle_collection_defer_begin() {\n  ++gea::detail::cycleState().deferDepth;\n}',
            requires: 'cycle-collectable-program'
          },
          {
            text:
              'extern "C" void __attribute__((weak)) gea_cycle_collection_defer_end() {\n' +
              '  auto& gea_state = gea::detail::cycleState();\n' +
              '  if (gea_state.deferDepth == 0) {\n' +
              '    std::fprintf(stderr, "gea: cycle collection deferral underflow\\n");\n' +
              '    std::abort();\n' +
              '  }\n' +
              '  --gea_state.deferDepth;\n' +
              '  try {\n' +
              '    gea::collectCyclesIfNeeded();\n' +
              '  } catch (const std::bad_alloc&) {\n' +
              '    std::fprintf(stderr, "gea: cycle collection deferred after allocation failure\\n");\n' +
              '  }\n' +
              '}',
            requires: 'cycle-collectable-program'
          },
          // The stylesheet the build compiled for this program -- see
          // `prelude.ts`. Empty for a program the build passed no prelude for,
          // which is every program outside the gea pipeline.
          ...geaCppPrelude(options).map((text) => ({ text, requires: null }))
        ]
      }
    }
  }
}
