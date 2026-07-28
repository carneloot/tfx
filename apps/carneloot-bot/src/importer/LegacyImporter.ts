import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';

import { sourceFingerprint } from './LegacyId.js';
import { LegacyImportConfig } from './LegacyImportConfig.js';
import { mapLegacySnapshot } from './LegacyMapping.js';
import { writeReportAtomic, type LegacyImportReport } from './LegacyReport.js';
import { decodeSnapshot } from './LegacySchemas.js';
import { LegacySource } from './LegacySource.js';
import { LegacyTarget } from './LegacyTarget.js';
import { verifyLegacy } from './LegacyVerification.js';
export const run = Effect.gen(function* () {
	const config = yield* LegacyImportConfig;
	const source = yield* LegacySource;
	const raw = yield* source.readSnapshot;
	const decoded = decodeSnapshot(raw);
	const fingerprint = yield* sourceFingerprint(config.sourceId);
	const now = yield* DateTime.now;
	const mapped = yield* mapLegacySnapshot(
		decoded.snapshot,
		fingerprint,
		config.botId,
		DateTime.toDateUtc(now),
	);
	let report: LegacyImportReport = verifyLegacy(
		decoded.snapshot,
		mapped,
		decoded.issues,
		config.dryRun ? 'dry-run' : 'import',
	);
	if (report.blockers.length === 0) {
		const target = yield* LegacyTarget;
		const promoted = yield* target.promote(mapped, { dryRun: config.dryRun });
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
	}
	if (config.reportPath) yield* writeReportAtomic(config.reportPath, report);
	return report;
});
