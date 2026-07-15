import * as Schema from 'effect/Schema';

export const RecipientRole = Schema.String.check(
	Schema.makeFilter(
		(value) =>
			new TextEncoder().encode(value).byteLength >= 1 &&
			new TextEncoder().encode(value).byteLength <= 64 &&
			/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value),
		{ message: 'Expected a lowercase kebab recipient role up to 64 bytes' },
	),
).pipe(Schema.brand('RecipientRole'));
export type RecipientRole = typeof RecipientRole.Type;
export const owner = Schema.decodeUnknownSync(RecipientRole)('owner');
export const caregiver = Schema.decodeUnknownSync(RecipientRole)('caregiver');
export const subscriber = Schema.decodeUnknownSync(RecipientRole)('subscriber');
