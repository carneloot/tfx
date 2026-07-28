/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { createClient } from '@libsql/client';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';

import { LegacyImportConfig } from './LegacyImportConfig.js';
import { LegacyImportError } from './LegacyImportError.js';
import {
	legacyTables,
	type LegacyRow,
	type LegacySnapshot,
} from './LegacySchemas.js';
import { LegacySource } from './LegacySource.js';

const sourceError = (cause: unknown) =>
	new LegacyImportError({
		reason: 'SourceUnavailable',
		message: 'Unable to read legacy source',
		cause,
	});
export const layer = Layer.effect(
	LegacySource,
	Effect.gen(function* () {
		const config = yield* LegacyImportConfig;
		const client = yield* Effect.try({
			try: () =>
				createClient({
					url: config.sourceUrl,
					...(config.sourceAuthToken
						? { authToken: Redacted.value(config.sourceAuthToken) }
						: {}),
				}),
			catch: sourceError,
		});
		yield* Effect.tryPromise({
			try: () => client.execute('PRAGMA query_only = ON'),
			catch: sourceError,
		});
		const pragma = yield* Effect.tryPromise({
			try: () => client.execute('PRAGMA query_only'),
			catch: sourceError,
		});
		if (Number(pragma.rows[0]?.query_only ?? 0) !== 1)
			return yield* Effect.fail(sourceError('query_only was not enabled'));
		return LegacySource.of({
			readSnapshot: Effect.forEach(
				legacyTables,
				(table) =>
					Effect.tryPromise({
						try: async () => {
							const result = await client.execute(
								`SELECT * FROM ${table} ORDER BY id`,
							);
							return [
								table,
								result.rows.map((row) => ({ ...row }) as LegacyRow),
							] as const;
						},
						catch: sourceError,
					}),
				{ concurrency: 'unbounded' },
			).pipe(
				Effect.map(
					(entries) => Object.fromEntries(entries) as unknown as LegacySnapshot,
				),
			),
		});
	}),
);
