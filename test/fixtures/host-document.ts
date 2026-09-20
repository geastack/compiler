declare interface Element {
  setAttribute(name: string, value: string): void
  getAttribute(name: string): string | null
  removeAttribute(name: string): void
  hasAttribute(name: string): boolean
  appendChild(child: Element): void
  remove(): void
}

declare interface Document {
  readonly body: Element
  getElementById(id: string): Element | null
  querySelector(selector: string): Element | null
  createElement(tag: string): Element
  createTextNode(text: string): Element
}

declare const document: Document

export function applySrc(path: string): void {
  const img = document.getElementById('cover-art')
  if (!img) return
  img.setAttribute('src', path)
}

export function mount(tag: string, label: string): void {
  const host = document.createElement(tag)
  host.setAttribute('class', 'panel')
  host.appendChild(document.createTextNode(label))
  document.body.appendChild(host)
}

export function attributeOf(selector: string, name: string): string {
  const found = document.querySelector(selector)
  if (!found) return ''
  if (!found.hasAttribute(name)) return ''
  const value = found.getAttribute(name)
  return value === null ? '' : value
}

export function absent(selector: string): boolean {
  const found = document.querySelector(selector)
  // Both spellings of the same question: `=== null` reads the optional's tag,
  // `!found` runs ToBoolean over it. Neither may become a conversion.
  return found === null || !found
}

// Called at module scope so the bodies are emitted rather than shaken away.
export const probeAttribute = attributeOf('#cover-art', 'src')
export const probeAbsent = absent('#missing')
applySrc('/cover.png')
mount('div', 'panel')
