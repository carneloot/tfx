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
export const run = Effect.gen(function* () {
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
	let report: LegacyImportReport = yield* Effect.sync(() =>
		verifyLegacy(
			decoded.snapshot,
			mapped,
			decoded.issues,
			config.dryRun ? 'dry-run' : 'import',
			startedAt,
		),
	).pipe(Effect.withSpan('legacy-import.verify'));
	let reminderFailure: LegacyImportError | undefined;
	if (report.blockers.length === 0 && !config.dryRun) {
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
		reminderFailure = yield* rebuildFeedingReminders(mapped.fingerprint).pipe(
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
	const completedAt = yield* DateTime.now;
	const duration = DateTime.distance(startedAt, completedAt);
	report = {
		...report,
		completedAt: DateTime.formatIso(completedAt),
		durationMs: Duration.toMillis(duration),
		duration: Duration.format(duration),
	};
	if (config.reportPath)
		yield* writeReportAtomic(config.reportPath, report).pipe(
			Effect.withSpan('legacy-import.write-report'),
		);
	if (reminderFailure) return yield* Effect.fail(reminderFailure);
	return report;
});
