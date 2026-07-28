import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import * as Random from 'effect/Random';

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

export const writeReportAtomic = (
	destination: string,
	report: LegacyImportReport,
) =>
	Effect.gen(function* () {
		const fileSystem = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const nonce = yield* Random.nextInt;
		const temporary = path.join(
			path.dirname(destination),
			`.${path.basename(destination)}.${nonce}.tmp`,
		);
		const write = fileSystem
			.writeFileString(
				temporary,
				`${JSON.stringify(normalizeReport(report), null, 2)}\n`,
				{ mode: 0o600 },
			)
			.pipe(Effect.andThen(fileSystem.rename(temporary, destination)));
		yield* write.pipe(
			Effect.ensuring(
				fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore),
			),
		);
	}).pipe(
		Effect.mapError(
			(cause) =>
				new LegacyImportError({
					reason: 'InvalidConfiguration',
					message: 'Unable to write import report',
					cause,
				}),
		),
	);
