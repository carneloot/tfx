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
	const sourceUpdates = new Map<string, string>();
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
		if (row.targetTable === 'pet_food_entries') {
			const collisionKey = `${String(row.value.source_bot_id)}:${String(row.value.source_update_id)}:${String(row.value.pet_id)}`;
			const previous = sourceUpdates.get(collisionKey);
			if (previous !== undefined)
				blockers.push(
					issue(
						'source-update-collision',
						row.sourceTable,
						row.sourceKey,
						`Conflicts with ${previous}`,
					),
				);
			else sourceUpdates.set(collisionKey, row.sourceKey);
		}
		if (row.targetTable === 'pet_food_settings') {
			const paired =
				(row.value.day_start === null) === (row.value.timezone === null);
			const delay = row.value.reminder_delay_ms;
			if (
				!paired ||
				(delay !== null &&
					(!Number.isSafeInteger(delay) ||
						Number(delay) < 1 ||
						Number(delay) > 2_592_000_000))
			)
				blockers.push(
					issue(
						'invalid-pet-food-settings',
						row.sourceTable,
						row.sourceKey,
						'Settings pair or reminder delay is invalid',
					),
				);
		}
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
	const ids = (table: keyof LegacySnapshot) =>
		new Set(snapshot[table].map((r) => String(r.id)));
	const users = ids('users'),
		pets = ids('pets'),
		notifications = ids('notifications');
	for (const row of snapshot.pets)
		if (!users.has(String(row.owner_id)))
			blockers.push(
				issue('missing-reference', 'pets', String(row.id), 'Missing owner'),
			);
	for (const row of snapshot.pet_carers)
		if (!pets.has(String(row.pet_id)) || !users.has(String(row.carer_id)))
			blockers.push(
				issue(
					'missing-reference',
					'pet_carers',
					String(row.id),
					'Missing pet or caregiver',
				),
			);
	for (const row of snapshot.pet_food)
		if (!pets.has(String(row.pet_id)) || !users.has(String(row.user_id)))
			blockers.push(
				issue(
					'missing-reference',
					'pet_food',
					String(row.id),
					'Missing pet or recorder',
				),
			);
	for (const row of snapshot.users_to_notify)
		if (
			!notifications.has(String(row.notification_id)) ||
			!users.has(String(row.user_id))
		)
			blockers.push(
				issue(
					'missing-reference',
					'users_to_notify',
					String(row.id),
					'Missing template or subscriber',
				),
			);
	for (const row of snapshot.notification_history)
		if (
			!users.has(String(row.user_id)) ||
			(row.pet_id !== null && !pets.has(String(row.pet_id))) ||
			(row.notification_id !== null &&
				!notifications.has(String(row.notification_id)))
		)
			blockers.push(
				issue(
					'missing-reference',
					'notification_history',
					String(row.id),
					'Missing history relation',
				),
			);
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
