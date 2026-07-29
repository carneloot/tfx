import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';

import { sourceFingerprint } from './LegacyId.js';
import { LegacyImportConfig } from './LegacyImportConfig.js';
import { LegacyImportError } from './LegacyImportError.js';
import { mapLegacySnapshot } from './LegacyMapping.js';
import { writeReportAtomic, type LegacyImportReport } from './LegacyReport.js';
import { decodeSnapshot } from './LegacySchemas.js';
import { LegacySource } from './LegacySource.js';
import { LegacyTarget } from './LegacyTarget.js';
import { verifyLegacy } from './LegacyVerification.js';
import { rebuildFeedingReminders } from './RebuildFeedingReminders.js';

const prepare = Effect.gen(function* () {
	const startedAt = yield* DateTime.now;
	const config = yield* LegacyImportConfig;
	const source = yield* LegacySource;
	const raw = yield* source.readSnapshot.pipe(
		Effect.withSpan('legacy-import.read-source'),
	);
	const decoded = yield* Effect.sync(() => decodeSnapshot(raw)).pipe(
		Effect.withSpan('legacy-import.decode-source'),
	);
	const fingerprint = yield* sourceFingerprint(config.sourceId);
	const mapped = yield* mapLegacySnapshot(
		decoded.snapshot,
		fingerprint,
		config.botId,
		DateTime.toDateUtc(startedAt),
	).pipe(Effect.withSpan('legacy-import.map-source'));
	const report = yield* Effect.sync(() =>
		verifyLegacy(
			decoded.snapshot,
			mapped,
			decoded.issues,
			config.dryRun ? 'dry-run' : 'import',
			startedAt,
		),
	).pipe(Effect.withSpan('legacy-import.verify'));
	return { config, startedAt, mapped, report };
});

const complete = (
	config: { readonly reportPath?: string },
	startedAt: DateTime.Utc,
	report: LegacyImportReport,
) =>
	Effect.gen(function* () {
		const completedAt = yield* DateTime.now;
		const completed = {
			...report,
			completedAt: DateTime.formatIso(completedAt),
			durationMs: Duration.toMillis(DateTime.distance(startedAt, completedAt)),
			duration: Duration.format(DateTime.distance(startedAt, completedAt)),
		};
		if (config.reportPath)
			yield* writeReportAtomic(config.reportPath, completed).pipe(
				Effect.withSpan('legacy-import.write-report'),
			);
		return completed;
	});

export const runDry = Effect.gen(function* () {
	const { config, startedAt, report } = yield* prepare;
	return yield* complete(config, startedAt, report);
});

export const runImport = Effect.gen(function* () {
	const { config, startedAt, mapped, report: initialReport } = yield* prepare;
	let report = initialReport;
	let reminderFailure: LegacyImportError | undefined;
	if (report.blockers.length === 0) {
		const target = yield* LegacyTarget;
		const promoted = yield* target.promote(mapped, { dryRun: false }).pipe(
			Effect.withSpan('legacy-import.promote', {
				attributes: { dryRun: false, mappedRows: mapped.rows.length },
			}),
		);
		const counts = Object.fromEntries(
			Object.entries(report.counts).map(([table, count]) => [
				table,
				{
					...count,
					inserted: promoted.inserted[table] ?? 0,
					existing: promoted.existing[table] ?? 0,
				},
			]),
		);
		report = { ...report, counts };
		reminderFailure = yield* rebuildFeedingReminders(
			mapped.fingerprint,
			config.botId,
		).pipe(
			Effect.as(undefined),
			Effect.catch((cause) =>
				Effect.succeed(
					new LegacyImportError({
						reason: 'ReminderRebuildFailed',
						message:
							'Legacy import completed but feeding reminder rebuild failed',
						cause,
					}),
				),
			),
		);
		report = {
			...report,
			reminderRebuild: reminderFailure === undefined ? 'completed' : 'failed',
		};
	}
	const completed = yield* complete(config, startedAt, report);
	if (reminderFailure) return yield* Effect.fail(reminderFailure);
	return completed;
});
