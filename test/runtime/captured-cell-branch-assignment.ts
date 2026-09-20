class NativeRenderingContext {
  getContextAttributes(): { alpha: boolean } {
    return { alpha: true }
  }
}

function captureAlpha(context: NativeRenderingContext | null, alpha: boolean): () => boolean {
  let selectedAlpha: boolean

  if (context !== null) {
    selectedAlpha = context.getContextAttributes().alpha
  } else {
    selectedAlpha = alpha
  }

  return () => selectedAlpha
}

//! expect: context true
//! expect: fallback true
console.log('context', captureAlpha(new NativeRenderingContext(), false)())
console.log('fallback', captureAlpha(null, true)())
