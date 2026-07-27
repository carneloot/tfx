import type { MappedLegacy } from './LegacyMapping.js';
import type { ImportIssue, LegacyImportReport } from './LegacyReport.js';
import type { DecodeIssue, LegacySnapshot } from './LegacySchemas.js';
const issue = (
	code: string,
	table: string,
	sourceKey: string,
	message: string,
): ImportIssue => ({ code, table, sourceKey, message });
export const verifyLegacy = (
	snapshot: LegacySnapshot,
	mapped: MappedLegacy,
	decodeIssues: ReadonlyArray<DecodeIssue>,
	mode: 'dry-run' | 'import',
): LegacyImportReport => {
	const blockers: ImportIssue[] = decodeIssues.map((i) =>
		issue(
			'invalid-source-row',
			i.table,
			i.sourceKey,
			`Invalid value at ${i.path}`,
		),
	);
	const seen = new Map<string, string>();
	for (const row of mapped.rows) {
		for (const [key, value] of Object.entries(row.value))
			if (
				(key.endsWith('_id') || key === 'owner_id' || key === 'recorded_by') &&
				value === undefined
			)
				blockers.push(
					issue(
						'missing-reference',
						row.sourceTable,
						row.sourceKey,
						`Missing referenced ${key}`,
					),
				);
		const unique = `${row.targetTable}:${row.targetKey}`;
		const old = seen.get(unique);
		if (old)
			blockers.push(
				issue(
					'duplicate-target-key',
					row.sourceTable,
					row.sourceKey,
					`Conflicts with ${old}`,
				),
			);
		else seen.set(unique, row.sourceKey);
	}
	for (const row of snapshot.users) {
		const telegram = Number(row.telegram_id);
		if (!Number.isSafeInteger(telegram) || telegram <= 0)
			blockers.push(
				issue(
					'unsafe-telegram-id',
					'users',
					String(row.id),
					'Telegram ID must be a positive safe integer',
				),
			);
	}
	for (const row of snapshot.api_keys)
		if (!/^[0-9a-f]{64}$/u.test(String(row.key)))
			blockers.push(
				issue(
					'invalid-api-key-hash',
					'api_keys',
					String(row.id),
					'API key hash is not lowercase SHA-256',
				),
			);
	const counts: Record<
		string,
		{
			source: number;
			accepted: number;
			skipped: number;
			existing: number;
			inserted: number;
		}
	> = {};
	for (const [table, sourceRows] of Object.entries(snapshot)) {
		const skipped =
			decodeIssues.filter((i) => i.table === table).length +
			(table === 'sessions' ? sourceRows.length : 0);
		counts[table] = {
			source:
				sourceRows.length +
				decodeIssues.filter((i) => i.table === table).length,
			accepted:
				sourceRows.length - (table === 'sessions' ? sourceRows.length : 0),
			skipped,
			existing: 0,
			inserted: 0,
		};
	}
	return {
		mode,
		sourceFingerprint: mapped.fingerprint,
		counts,
		rounding: mapped.rounding,
		warnings: mapped.warnings,
		blockers,
		reminderRebuild: 'not-run',
	};
};
