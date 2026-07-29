import * as PgClient from '@effect/sql-pg/PgClient';
import * as TfxPostgres from '@tfx/postgres/TfxPostgres';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type * as Redacted from 'effect/Redacted';
import { Command } from 'effect/unstable/cli';
import * as JobRuntimeLive from 'tfx/JobRuntime';

import { migrate } from '../postgres/AppMigrator.js';
import * as NotificationRepositoryLive from '../postgres/NotificationRepositoryLive.js';
import * as PetFoodRepositoryLive from '../postgres/PetFoodRepositoryLive.js';
import * as ReminderSchedulerLive from '../postgres/ReminderSchedulerLive.js';
import { flags, migrationFlags, toConfig } from './Cli.js';
import { LegacyImportConfig, layerFrom } from './LegacyImportConfig.js';
import { runDry, runImport } from './LegacyImporter.js';
import { LegacyImportError } from './LegacyImportError.js';
import {
	countSummary,
	type ImportIssue,
	type LegacyImportReport,
} from './LegacyReport.js';
import * as LegacySourceLive from './LegacySourceLive.js';
import * as LegacyTargetLive from './LegacyTargetLive.js';

export const blockerSummary = (
	blockers: ReadonlyArray<ImportIssue>,
	reportPath: string | undefined,
) => {
	const visible = [...blockers].sort((left, right) =>
		`${left.table}\0${left.sourceKey}\0${left.code}`.localeCompare(
			`${right.table}\0${right.sourceKey}\0${right.code}`,
		),
	);
	const limit = 20;
	const details = visible
		.slice(0, limit)
		.map(
			(blocker) =>
				`- ${blocker.table}/${blocker.sourceKey} [${blocker.code}]: ${blocker.message}`,
		)
		.join('\n');
	const remaining = visible.length - limit;
	return [
		`Legacy import blocked by ${visible.length} verification issue(s):`,
		details,
		...(remaining > 0 ? [`... ${remaining} more issue(s) omitted`] : []),
		reportPath
			? `Full report: ${reportPath}`
			: 'Pass --report <path> to write the complete sanitized report.',
	].join('\n');
};

const targetInfrastructure = (
	databaseUrl: Redacted.Redacted<string>,
	botId: string,
) => {
	const persistence = TfxPostgres.layer({
		schema: 'tfx',
		tablePrefix: 'carneloot_',
		botId,
	});
	const jobs = Layer.provideMerge(JobRuntimeLive.layer(), persistence);
	const repositories = Layer.merge(
		PetFoodRepositoryLive.layer,
		NotificationRepositoryLive.layer,
	);
	const reminders = Layer.provideMerge(
		ReminderSchedulerLive.layer,
		Layer.merge(Layer.merge(persistence, repositories), jobs),
	);
	return Layer.merge(LegacyTargetLive.layer, reminders).pipe(
		Layer.provideMerge(PgClient.layer({ url: databaseUrl })),
	);
};

const completeImport = (
	report: LegacyImportReport,
	reportPath: string | undefined,
) =>
	Effect.gen(function* () {
		yield* Effect.logInfo(countSummary(report));
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
					message: blockerSummary(report.blockers, reportPath),
				}),
			);
	});

const importLegacy = (config: ReturnType<typeof toConfig>) => {
	const workflow = config.dryRun
		? runDry.pipe(Effect.provide(LegacySourceLive.layer))
		: config.databaseUrl
			? runImport.pipe(
					Effect.provide(
						Layer.merge(
							LegacySourceLive.layer,
							targetInfrastructure(config.databaseUrl, config.botId),
						),
					),
				)
			: Effect.fail(
					new LegacyImportError({
						reason: 'InvalidConfiguration',
						message:
							'Target PostgreSQL connection URL is required unless --dry-run is set',
					}),
				);
	return workflow.pipe(
		Effect.tap((report) => completeImport(report, config.reportPath)),
		Effect.withSpan('legacy-import.import'),
		Effect.provide(layerFrom(config)),
	);
};

export const commandMigrate = Command.make('migrate', migrationFlags).pipe(
	Command.withDescription('Create or update legacy import target tables.'),
	Command.withHandler((parsed) =>
		migrate.pipe(
			Effect.withSpan('legacy-import.migrate'),
			Effect.provide(PgClient.layer({ url: parsed.databaseUrl })),
		),
	),
);

export const commandImport = Command.make('import', flags).pipe(
	Command.withDescription(
		'Validate and import legacy Carneloot SQLite/libSQL data into PostgreSQL.',
	),
	Command.withHandler((parsed) => importLegacy(toConfig(parsed))),
);

export const command = Command.make('import:legacy').pipe(
	Command.withDescription('Manage Carneloot legacy data imports.'),
	Command.withSubcommands([commandMigrate, commandImport]),
);
