// `Part` is named only inside other types here and never imported, as
// `BindGroup` is in three's `Bindings.js`.
/**
 * @param {Array<Part>} parts - The parts.
 * @return {string} The labels.
 */
export function labelsOf( parts ) {
	let labels = '';
	for ( const part of parts ) labels += part.label();
	return labels;
}
/**
 * @param {?Array<Part>} parts - The parts, if any.
 * @return {number} How many.
 */
export function countOf( parts ) {
	return parts === null ? 0 : parts.length;
}
