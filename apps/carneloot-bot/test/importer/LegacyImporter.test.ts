import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, Layer, Ref } from 'effect';
import * as DateTime from 'effect/DateTime';
import { describe, expect, it } from 'vitest';

import { LegacyImportConfig } from '../../src/importer/LegacyImportConfig.js';
import { runDry } from '../../src/importer/LegacyImporter.js';
import {
	legacyTables,
	type LegacySnapshot,
} from '../../src/importer/LegacySchemas.js';
import { LegacySource } from '../../src/importer/LegacySource.js';
import { verifyLegacy } from '../../src/importer/LegacyVerification.js';

const emptySnapshot = () =>
	Object.fromEntries(
		legacyTables.map((table) => [table, []]),
	) as unknown as LegacySnapshot;

describe('legacy importer', () => {
	it('dry run requires no target service', async () => {
		const reads = await Effect.runPromise(
			Effect.gen(function* () {
				const calls = yield* Ref.make(0);
				const source = Layer.succeed(LegacySource, {
					readSnapshot: Ref.update(calls, (count) => count + 1).pipe(
						Effect.as(emptySnapshot()),
					),
				});
				const config = Layer.succeed(LegacyImportConfig, {
					sourceUrl: 'file:fixture.db',
					sourceId: 'fixture',
					botId: 'carneloot',
					dryRun: true,
				});
				yield* runDry.pipe(
					Effect.provide(
						Layer.mergeAll(
							source,
							config,
							NodeCrypto.layer,
							NodeServices.layer,
						),
					),
				);
				return yield* Ref.get(calls);
			}),
		);
		expect(reads).toBe(1);
	});

	it('excludes known pet config for non-imported pet with warning', async () => {
		const report = await Effect.runPromise(
			Effect.gen(function* () {
				const startedAt = yield* DateTime.now;
				return verifyLegacy(
					{
						...emptySnapshot(),
						configs: [
							{
								id: 'config-1',
								context: 'pet:deleted-pet',
								key: 'dayStart',
								value: '{"hour":8,"timezone":"UTC"}',
							},
						],
					},
					{ fingerprint: 'fixture', rows: [], rounding: [], warnings: [] },
					[],
					'dry-run',
					startedAt,
				);
			}),
		);
		expect(report.blockers).toEqual([]);
		expect(report.warnings).toContainEqual({
			code: 'non-imported-pet-config-excluded',
			table: 'configs',
			sourceKey: 'config-1',
			message: 'Pet-food configuration for non-imported pet is excluded',
		});
		expect(report.counts.configs).toMatchObject({ accepted: 0, skipped: 1 });
	});
});
