import * as Effect from 'effect/Effect';
import { rename, writeFile } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

import { LegacyImportError } from './LegacyImportError.js';
import type { RoundingNotice } from './LegacyMapping.js';
export interface ImportIssue {
	readonly code: string;
	readonly table: string;
	readonly sourceKey: string;
	readonly message: string;
}
export interface LegacyImportReport {
	readonly mode: 'dry-run' | 'import';
	readonly sourceFingerprint: string;
	readonly counts: Readonly<
		Record<
			string,
			{
				source: number;
				accepted: number;
				skipped: number;
				existing: number;
				inserted: number;
			}
		>
	>;
	readonly rounding: ReadonlyArray<RoundingNotice>;
	readonly warnings: ReadonlyArray<ImportIssue>;
	readonly blockers: ReadonlyArray<ImportIssue>;
	readonly reminderRebuild: 'not-run' | 'completed' | 'failed';
}
const sorted = (issues: ReadonlyArray<ImportIssue>) =>
	[...issues].sort((a, b) =>
		`${a.table}\0${a.sourceKey}\0${a.code}`.localeCompare(
			`${b.table}\0${b.sourceKey}\0${b.code}`,
		),
	);
export const normalizeReport = (
	report: LegacyImportReport,
): LegacyImportReport => ({
	...report,
	warnings: sorted(report.warnings),
	blockers: sorted(report.blockers),
});
export const writeReportAtomic = (path: string, report: LegacyImportReport) =>
	Effect.tryPromise({
		try: async () => {
			const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
			await writeFile(
				temp,
				`${JSON.stringify(normalizeReport(report), null, 2)}\n`,
				{ mode: 0o600 },
			);
			await rename(temp, path);
		},
		catch: (cause) =>
			new LegacyImportError({
				reason: 'InvalidConfiguration',
				message: 'Unable to write import report',
				cause,
			}),
	});
