import * as DateTime from 'effect/DateTime';
import * as Schema from 'effect/Schema';

import type { MappedLegacy } from './LegacyMapping.js';
import type { ImportIssue, LegacyImportReport } from './LegacyReport.js';
import {
	decodeLegacyConfigValue,
	LegacyNotificationDelay,
	LegacyPetDayStart,
	type DecodeIssue,
	type LegacySnapshot,
} from './LegacySchemas.js';
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
	startedAt: DateTime.Utc,
): LegacyImportReport => {
	const blockers: ImportIssue[] = decodeIssues.map((i) =>
		issue(
			'invalid-source-row',
			i.table,
			i.sourceKey,
			`Invalid value at ${i.path}`,
		),
	);
	const warnings: ImportIssue[] = [];
	const seen = new Map<string, string>();
	const sourceUpdates = new Map<string, string>();
	const petNames = new Map<string, string>();
	const apiKeyHashes = new Map<string, string>();
	const deliveryIdentities = new Map<string, string>();
	const excluded = new Map<string, Set<string>>();
	const exclude = (table: string, sourceKey: string) => {
		const keys = excluded.get(table) ?? new Set<string>();
		keys.add(sourceKey);
		excluded.set(table, keys);
	};
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
		if (row.targetTable === 'pets') {
			const key = `${String(row.value.owner_id)}:${String(row.value.name_key)}`;
			const previous = petNames.get(key);
			if (previous !== undefined)
				blockers.push(
					issue(
						'duplicate-normalized-pet-name',
						row.sourceTable,
						row.sourceKey,
						`Conflicts with ${previous}`,
					),
				);
			else petNames.set(key, row.sourceKey);
		}
		if (row.targetTable === 'api_keys') {
			const key = String(row.value.key_hash);
			const previous = apiKeyHashes.get(key);
			if (previous !== undefined)
				blockers.push(
					issue(
						'duplicate-api-key-hash',
						row.sourceTable,
						row.sourceKey,
						`Conflicts with ${previous}`,
					),
				);
			else apiKeyHashes.set(key, row.sourceKey);
		}
		if (row.targetTable === 'notification_deliveries') {
			const key = `${String(row.value.telegram_bot_id)}:${String(row.value.recipient_chat_id)}:${String(row.value.telegram_message_id)}`;
			const previous = deliveryIdentities.get(key);
			if (previous !== undefined)
				blockers.push(
					issue(
						'duplicate-delivery-identity',
						row.sourceTable,
						row.sourceKey,
						`Conflicts with ${previous}`,
					),
				);
			else deliveryIdentities.set(key, row.sourceKey);
		}
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
	for (const row of snapshot.pet_carers) {
		const pet = snapshot.pets.find(
			(candidate) => String(candidate.id) === String(row.pet_id),
		);
		if (!pets.has(String(row.pet_id)) || !users.has(String(row.carer_id)))
			blockers.push(
				issue(
					'missing-reference',
					'pet_carers',
					String(row.id),
					'Missing pet or caregiver',
				),
			);
		if (pet !== undefined && String(pet.owner_id) === String(row.carer_id))
			blockers.push(
				issue(
					'self-caregiver',
					'pet_carers',
					String(row.id),
					'Pet owner cannot be caregiver',
				),
			);
	}
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
	for (const row of snapshot.configs) {
		const sourceKey = String(row.id);
		const match = /^pet:(.+)$/u.exec(String(row.context));
		if (!match || (row.key !== 'dayStart' && row.key !== 'notificationDelay')) {
			exclude('configs', sourceKey);
			continue;
		}
		const petId = match[1];
		if (petId === undefined || !pets.has(petId)) {
			exclude('configs', sourceKey);
			warnings.push(
				issue(
					'non-imported-pet-config-excluded',
					'configs',
					sourceKey,
					'Pet-food configuration for non-imported pet is excluded',
				),
			);
			continue;
		}
		try {
			const value = decodeLegacyConfigValue(row.value);
			Schema.decodeUnknownSync(
				row.key === 'dayStart' ? LegacyPetDayStart : LegacyNotificationDelay,
			)(value);
		} catch {
			exclude('configs', sourceKey);
			blockers.push(
				issue(
					'invalid-pet-food-config',
					'configs',
					sourceKey,
					'Known pet-food configuration is invalid',
				),
			);
		}
	}
	for (const warning of mapped.warnings)
		if (warning.table === 'configs') exclude('configs', warning.sourceKey);
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
		const decoded = decodeIssues.filter((i) => i.table === table).length;
		const skippedRows =
			(table === 'sessions' ? sourceRows.length : 0) +
			(excluded.get(table)?.size ?? 0);
		counts[table] = {
			source: sourceRows.length + decoded,
			accepted: sourceRows.length - skippedRows,
			skipped: decoded + skippedRows,
			existing: 0,
			inserted: 0,
		};
	}
	return {
		mode,
		startedAt: DateTime.formatIso(startedAt),
		completedAt: DateTime.formatIso(startedAt),
		durationMs: 0,
		duration: '0ms',
		sourceFingerprint: mapped.fingerprint,
		counts,
		rounding: mapped.rounding,
		warnings: [...mapped.warnings, ...warnings],
		blockers,
		reminderRebuild: 'not-run',
	};
};
