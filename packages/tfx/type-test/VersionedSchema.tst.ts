import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import * as VersionedSchema from '../src/VersionedSchema.js';

const history = VersionedSchema.history(
	VersionedSchema.version(1, Schema.Struct({ old: Schema.String })),
).pipe(
	VersionedSchema.to(
		VersionedSchema.version(2, Schema.Struct({ value: Schema.Number })),
		(old) => ({ value: old.old.length }),
	),
);

const _latestVersion: 2 = history.latest.version;
const _migrate: Effect.Effect<
	{ readonly value: number },
	VersionedSchema.VersionedSchemaError | Schema.SchemaError
> = history.migrate(1, { old: 'value' });
const _decode: Effect.Effect<
	{ readonly value: number },
	VersionedSchema.VersionedSchemaError | Schema.SchemaError
> = history.decode({ version: 2, state: { value: 5 } });
void [_latestVersion, _migrate, _decode];
