import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as PgClient from '@effect/sql-pg/PgClient';
import { Effect, Layer, Redacted, Ref } from 'effect';
import { describe, expect, it } from 'vitest';

import { LegacyImportConfig } from '../../src/importer/LegacyImportConfig.js';
import { run } from '../../src/importer/LegacyImporter.js';
import {
	legacyTables,
	type LegacySnapshot,
} from '../../src/importer/LegacySchemas.js';
import { LegacySource } from '../../src/importer/LegacySource.js';
import { LegacyTarget } from '../../src/importer/LegacyTarget.js';
import { ReminderScheduler } from '../../src/ports/ReminderScheduler.js';

const emptySnapshot = () =>
	Object.fromEntries(
		legacyTables.map((table) => [table, []]),
	) as unknown as LegacySnapshot;

describe('legacy importer', () => {
	it('does not promote target during dry run', async () => {
		const promoted = await Effect.runPromise(
			Effect.gen(function* () {
				const calls = yield* Ref.make(0);
				const target = Layer.succeed(LegacyTarget, {
					promote: () =>
						Ref.update(calls, (count) => count + 1).pipe(Effect.die),
				});
				const source = Layer.succeed(LegacySource, {
					readSnapshot: Effect.succeed(emptySnapshot()),
				});
				const config = Layer.succeed(LegacyImportConfig, {
					sourceUrl: 'file:fixture.db',
					sourceId: 'fixture',
					botId: 'carneloot',
					databaseUrl: Redacted.make('postgres://test'),
					dryRun: true,
				});
				const scheduler = Layer.succeed(ReminderScheduler, {
					replaceForLatest: () => Effect.void,
					cancelForPet: () => Effect.void,
				});
				yield* run.pipe(
					Effect.provide(
						Layer.mergeAll(
							target,
							source,
							config,
							scheduler,
							Layer.succeed(PgClient.PgClient, undefined as never),
							NodeCrypto.layer,
							NodeServices.layer,
						),
					),
				);
				return yield* Ref.get(calls);
			}),
		);
		expect(promoted).toBe(0);
	});
});
