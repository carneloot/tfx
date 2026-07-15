export type Identifier = string & { readonly Identifier: unique symbol };
const pattern = /^[a-z_][a-z0-9_]*$/u;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
export const identifier = (value: string, label = 'identifier'): Identifier => {
	if (!pattern.test(value))
		throw new TypeError(`${label} must match ${pattern.source}`);
	if (bytes(value) > 63)
		throw new TypeError(`${label} exceeds PostgreSQL 63-byte limit`);
	return value as Identifier;
};
export const composed = (prefix: Identifier, suffix: string): Identifier =>
	identifier(`${prefix}${suffix}`, 'composed table identifier');
