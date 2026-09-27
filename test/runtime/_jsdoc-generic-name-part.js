// Exported as the module's default, the way three exports its classes.
class Part {
	/** @param {string} tag - The tag. */
	constructor( tag ) {
		this.tag = tag;
	}
	/** @return {string} The tag. */
	label() {
		return this.tag;
	}
}
export default Part;
