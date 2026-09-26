// Neither tag's name is imported here, as in three's own files.
/**
 * @param {Texture} texture - The texture.
 * @param {Device} [device] - The device.
 * @return {string} The format.
 */
export function getFormat( texture, device ) {
	if ( device !== undefined ) return device.name + texture.format;
	return 'none' + texture.format;
}
/**
 * @param {Texture} light - The light.
 * @param {?Shadow} [shadow=null] - An optional shadow.
 * @return {string} What was passed.
 */
export const pointShadow = ( light, shadow ) => ( shadow === undefined ? 'omitted' : shadow === null ? 'null' : 'shadow' ) + light.format;
