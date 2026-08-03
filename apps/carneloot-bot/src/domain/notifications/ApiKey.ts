import * as Schema from 'effect/Schema';

import { Uuid } from '../Uuid.js';

export const ApiKeyId = Uuid.pipe(Schema.brand('ApiKeyId'));
export type ApiKeyId = typeof ApiKeyId.Type;
export const ApiKeyHash = Schema.String.check(
	Schema.makeFilter((value) => /^[0-9a-f]{64}$/u.test(value)),
).pipe(Schema.brand('ApiKeyHash'));
export type ApiKeyHash = typeof ApiKeyHash.Type;
