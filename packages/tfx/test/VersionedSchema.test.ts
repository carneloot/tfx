import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import * as VersionedSchema from '../src/VersionedSchema.js';

describe('VersionedSchema', () => {
	it('migrates contiguous histories deterministically', async () => {
		const v2 = VersionedSchema.history(
			VersionedSchema.version(1, Schema.Struct({ name: Schema.String })),
		).pipe(
			VersionedSchema.to(
				VersionedSchema.version(2, Schema.Struct({ renamed: Schema.String })),
				(v) => ({ renamed: v.name }),
			),
		);
		const history = v2.pipe(
			VersionedSchema.to(
				VersionedSchema.version(3, Schema.Struct({ label: Schema.String })),
				(v) => ({ label: v.renamed }),
			),
		);
		await expect(
			Effect.runPromise(history.decode({ version: 1, state: { name: 'Ada' } })),
		).resolves.toEqual({ label: 'Ada' });
		await expect(
			Effect.runPromise(history.decode({ version: 9, state: {} })),
		).rejects.toMatchObject({ reason: 'MissingMigration' });
	});
	it('rejects invalid versions and gaps', () => {
		expect(() => VersionedSchema.version(0, Schema.String)).toThrow('positive');
		const h = VersionedSchema.history(
			VersionedSchema.version(1, Schema.String),
		);
		expect(() =>
			h.pipe(
				VersionedSchema.to(VersionedSchema.version(3, Schema.String), String),
			),
		).toThrow('Expected version 2');
	});
	it('reports decode failures', async () => {
		const h = VersionedSchema.history(
			VersionedSchema.version(1, Schema.String),
		);
		await expect(
			Effect.runPromise(h.decode({ version: 1, state: 1 })),
		).rejects.toBeDefined();
	});
});
