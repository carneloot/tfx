import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { Command } from 'effect/unstable/cli';

import { migrate } from '../postgres/AppMigrator.js';
import { flags, toConfig } from './Cli.js';
import { LegacyImportConfig, layerFrom } from './LegacyImportConfig.js';
import { run } from './LegacyImporter.js';
import { LegacyImportError } from './LegacyImportError.js';
import * as LegacySourceLive from './LegacySourceLive.js';
import * as LegacyTargetLive from './LegacyTargetLive.js';

const infrastructure = Layer.unwrap(
	Effect.map(LegacyImportConfig, (config) =>
		Layer.merge(LegacySourceLive.layer, LegacyTargetLive.layer).pipe(
			Layer.provideMerge(PgClient.layer({ url: config.databaseUrl })),
		),
	),
);

const importLegacy = Effect.gen(function* () {
	const config = yield* LegacyImportConfig;
	if (!config.dryRun) yield* migrate;
	const report = yield* run;
	yield* Effect.logInfo('carneloot.legacy_import.completed').pipe(
		Effect.annotateLogs({
			mode: report.mode,
			blockers: report.blockers.length,
			warnings: report.warnings.length,
		}),
	);
	if (report.blockers.length > 0)
		return yield* Effect.fail(
			new LegacyImportError({
				reason: 'Blocked',
				message: 'Legacy import verification found blockers',
			}),
		);
}).pipe(Effect.provide(infrastructure));

export const command = Command.make('import:legacy', flags).pipe(
	Command.withDescription(
		'Import legacy Carneloot SQLite/libSQL data into PostgreSQL.',
	),
	Command.withHandler((parsed) =>
		importLegacy.pipe(Effect.provide(layerFrom(toConfig(parsed)))),
	),
);
