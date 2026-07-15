import * as Schema from 'effect/Schema';
import * as SchemaGetter from 'effect/SchemaGetter';

import type { PetId, UserId } from './Ids.js';

const utf8 = (value: string) => new TextEncoder().encode(value).byteLength;
export const normalizePetName = (value: string): string =>
	value.normalize('NFC').replace(/\s+/gu, ' ').trim();
export const petNameKey = (value: string): string =>
	normalizePetName(value).toLocaleLowerCase('und');
const validPetName = (value: string) => {
	const display = normalizePetName(value);
	const key = petNameKey(display);
	return (
		display.length > 0 &&
		!/\p{Cc}/u.test(display) &&
		utf8(display) >= 1 &&
		utf8(display) <= 80 &&
		utf8(key) >= 1 &&
		utf8(key) <= 80
	);
};
export const PetName = Schema.String.check(
	Schema.makeFilter(validPetName, { message: 'Invalid pet name' }),
).pipe(
	Schema.decodeTo(Schema.String, {
		decode: SchemaGetter.transform(normalizePetName),
		encode: SchemaGetter.transform((value) => value),
	}),
);
export type PetName = typeof PetName.Type;
export interface Pet {
	readonly id: PetId;
	readonly ownerId: UserId;
	readonly name: PetName;
	readonly createdAt: number;
	readonly updatedAt: number;
}
