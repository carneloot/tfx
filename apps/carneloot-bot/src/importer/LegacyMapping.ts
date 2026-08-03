import * as Crypto from 'effect/Crypto';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/consistent-type-assertions */
import { createHash } from 'node:crypto';

import { legacyId } from './LegacyId.js';
import {
	decodeLegacyConfigValue,
	LegacyNotificationDelay,
	LegacyPetDayStart,
	type LegacyRow,
	type LegacySnapshot,
} from './LegacySchemas.js';

export interface MappedRow {
	readonly sourceTable: string;
	readonly sourceKey: string;
	readonly targetTable: string;
	readonly targetKey: string;
	readonly value: Readonly<Record<string, unknown>>;
	readonly ignoredComparisonFields?: ReadonlyArray<string>;
}
export interface RoundingNotice {
	readonly table: 'pet_food';
	readonly sourceKey: string;
	readonly sourceGrams: number;
	readonly resultMg: number;
	readonly deltaMg: number;
}
export interface MappedLegacy {
	readonly fingerprint: string;
	readonly rows: ReadonlyArray<MappedRow>;
	readonly rounding: ReadonlyArray<RoundingNotice>;
	readonly warnings: ReadonlyArray<{
		code: string;
		table: string;
		sourceKey: string;
		message: string;
	}>;
}
const encoder = new TextEncoder();
const num = (v: unknown) => (typeof v === 'bigint' ? Number(v) : Number(v));
const date = (v: unknown) => new Date(num(v) * 1000).toISOString();
const id = (r: LegacyRow) => String(r.id);
export const updateIdFromDigest = (digest: Uint8Array) => {
	// Keep exactly the first 53 bits. Bitwise operators would truncate to 32.
	let n = 0;
	for (const b of digest.slice(0, 6)) n = n * 256 + b;
	return n * 32 + ((digest[6] ?? 0) >>> 3);
};
export const mapLegacySnapshot = (
	snapshot: LegacySnapshot,
	fingerprint: string,
	botId: string,
	importedAt: Date,
) =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto;
		const ids = new Map<string, string>();
		for (const table of [
			'users',
			'pets',
			'pet_carers',
			'pet_food',
			'api_keys',
			'notifications',
			'notification_history',
		] as const)
			for (const row of snapshot[table])
				ids.set(
					`${table}:${id(row)}`,
					yield* legacyId(fingerprint, table, id(row)),
				);
		const rows: MappedRow[] = [];
		const importedAuditFields = ['created_at', 'updated_at'];
		const rounding: RoundingNotice[] = [];
		const warnings: MappedLegacy['warnings'][number][] = [];
		const add = (
			sourceTable: string,
			sourceKey: string,
			targetTable: string,
			targetKey: string,
			value: Record<string, unknown>,
			ignoredComparisonFields: ReadonlyArray<string> = [],
		) =>
			rows.push({
				sourceTable,
				sourceKey,
				targetTable,
				targetKey,
				value,
				ignoredComparisonFields,
			});
		for (const r of snapshot.users) {
			const telegram = num(r.telegram_id);
			const uid = ids.get(`users:${id(r)}`)!;
			add(
				'users',
				id(r),
				'users',
				uid,
				{
					id: uid,
					created_at: importedAt.toISOString(),
					updated_at: importedAt.toISOString(),
				},
				importedAuditFields,
			);
			add(
				'users',
				id(r),
				'telegram_identities',
				`${botId}:${telegram}`,
				{
					bot_id: botId,
					telegram_user_id: telegram,
					user_id: uid,
					username: r.username,
					first_name: r.first_name,
					last_name: r.last_name,
					private_chat_id: telegram,
					created_at: importedAt.toISOString(),
					updated_at: importedAt.toISOString(),
				},
				importedAuditFields,
			);
		}
		for (const r of snapshot.pets) {
			const pid = ids.get(`pets:${id(r)}`)!;
			add(
				'pets',
				id(r),
				'pets',
				pid,
				{
					id: pid,
					owner_id: ids.get(`users:${r.owner_id}`),
					name: r.name,
					name_key: String(r.name)
						.normalize('NFKC')
						.trim()
						.toLocaleLowerCase('pt-BR'),
					created_at: importedAt.toISOString(),
					updated_at: importedAt.toISOString(),
				},
				importedAuditFields,
			);
		}
		for (const r of snapshot.pet_carers) {
			const petId = ids.get(`pets:${r.pet_id}`),
				userId = ids.get(`users:${r.carer_id}`);
			add(
				'pet_carers',
				id(r),
				'pet_caregivers',
				`${petId}:${userId}`,
				{
					pet_id: petId,
					caregiver_user_id: userId,
					status: r.status,
					created_at: importedAt.toISOString(),
					updated_at: importedAt.toISOString(),
				},
				importedAuditFields,
			);
		}
		for (const r of snapshot.pet_food) {
			const exact = num(r.quantity) * 1000,
				amount = Math.round(exact),
				fid = ids.get(`pet_food:${id(r)}`)!;
			if (exact !== amount)
				rounding.push({
					table: 'pet_food',
					sourceKey: id(r),
					sourceGrams: num(r.quantity),
					resultMg: amount,
					deltaMg: amount - exact,
				});
			const digest = yield* crypto.digest(
				'SHA-256',
				encoder.encode(`${fingerprint}:pet_food:update:${id(r)}`),
			);
			const actor = snapshot.users.find((u) => id(u) === r.user_id);
			const message = r.message_id === null ? null : num(r.message_id);
			add(
				'pet_food',
				id(r),
				'pet_food_entries',
				fid,
				{
					id: fid,
					pet_id: ids.get(`pets:${r.pet_id}`),
					recorded_by: ids.get(`users:${r.user_id}`),
					amount_mg: amount,
					fed_at: date(r.time),
					source_bot_id: botId,
					source_update_id: updateIdFromDigest(digest),
					source_message_chat_id:
						message === null ? null : num(actor?.telegram_id),
					source_message_id: message,
					created_at: importedAt.toISOString(),
					updated_at: importedAt.toISOString(),
				},
				importedAuditFields,
			);
		}
		const settings = new Map<string, Record<string, unknown>>();
		for (const r of snapshot.configs) {
			const configKey = id(r);
			const match = /^pet:(.+)$/u.exec(String(r.context));
			if (!match) {
				warnings.push({
					code:
						String(r.key) === 'showNotifications'
							? 'user-notification-preference-not-migrated'
							: 'unknown-config-context',
					table: 'configs',
					sourceKey: configKey,
					message: 'Unsupported legacy configuration is excluded',
				});
				continue;
			}
			const petId = ids.get(`pets:${match[1]}`);
			if (r.key !== 'dayStart' && r.key !== 'notificationDelay') {
				warnings.push({
					code: 'unknown-config-key',
					table: 'configs',
					sourceKey: configKey,
					message: 'Unsupported legacy configuration is excluded',
				});
				continue;
			}
			if (!petId) continue;
			const current = settings.get(petId) ?? {};
			try {
				const value = decodeLegacyConfigValue(r.value);
				if (r.key === 'dayStart') {
					const dayStart = Schema.decodeUnknownSync(LegacyPetDayStart)(value);
					current.day_start = `${String(dayStart.hour).padStart(2, '0')}:00`;
					current.timezone = dayStart.timezone;
				} else {
					const delay = Schema.decodeUnknownSync(LegacyNotificationDelay)(
						value,
					);
					current.reminder_delay_ms =
						((num(delay.days ?? 0) * 24 + num(delay.hours ?? 0)) * 60 +
							num(delay.minutes ?? 0)) *
							60_000 +
						num(delay.seconds ?? 0) * 1000;
				}
				settings.set(petId, current);
			} catch {
				// Verification reports invalid known settings before promotion.
			}
		}
		for (const [petId, setting] of settings)
			add(
				'configs',
				`pet:${petId}`,
				'pet_food_settings',
				petId,
				{
					pet_id: petId,
					day_start: setting.day_start ?? null,
					timezone: setting.timezone ?? null,
					reminder_delay_ms: setting.reminder_delay_ms ?? null,
					created_at: importedAt.toISOString(),
					updated_at: importedAt.toISOString(),
				},
				importedAuditFields,
			);
		for (const r of snapshot.api_keys) {
			const kid = ids.get(`api_keys:${id(r)}`)!;
			add('api_keys', id(r), 'api_keys', kid, {
				id: kid,
				user_id: ids.get(`users:${r.user_id}`),
				key_hash: r.key,
				created_at: date(r.created_at),
				updated_at: date(r.created_at),
			});
		}
		for (const r of snapshot.notifications) {
			const nid = ids.get(`notifications:${id(r)}`)!;
			add(
				'notifications',
				id(r),
				'notification_templates',
				nid,
				{
					id: nid,
					owner_user_id: ids.get(`users:${r.owner_id}`),
					keyword: r.keyword,
					message: r.message,
					created_at: importedAt.toISOString(),
					updated_at: importedAt.toISOString(),
				},
				importedAuditFields,
			);
		}
		for (const r of snapshot.users_to_notify) {
			const key = `${ids.get(`notifications:${r.notification_id}`)}:${ids.get(`users:${r.user_id}`)}`;
			add(
				'users_to_notify',
				id(r),
				'notification_subscriptions',
				key,
				{
					template_id: ids.get(`notifications:${r.notification_id}`),
					user_id: ids.get(`users:${r.user_id}`),
					created_at: importedAt.toISOString(),
				},
				['created_at'],
			);
		}
		for (const r of snapshot.notification_history) {
			const hid = ids.get(`notification_history:${id(r)}`)!;
			const user = snapshot.users.find((u) => id(u) === r.user_id);
			const template = snapshot.notifications.find(
				(n) => id(n) === r.notification_id,
			);
			const pet = snapshot.pets.find((p) => id(p) === r.pet_id);
			const ownerId = template?.owner_id ?? pet?.owner_id;
			const sentAt = date(r.sent_at);
			add('notification_history', id(r), 'notification_events', hid, {
				id: hid,
				bot_id: botId,
				kind: 'legacy-notification',
				owner_user_id: ids.get(`users:${ownerId}`),
				pet_id: r.pet_id === null ? null : ids.get(`pets:${r.pet_id}`),
				food_entry_id: null,
				scheduled_for: null,
				status: 'completed',
				dedupe_key: `legacy:${fingerprint}:${id(r)}`,
				job_id: null,
				created_at: sentAt,
				updated_at: sentAt,
				completed_at: sentAt,
				cancelled_at: null,
			});
			add(
				'notification_history',
				`${id(r)}:delivery`,
				'notification_deliveries',
				hid,
				{
					id: hid,
					event_id: hid,
					recipient_user_id: ids.get(`users:${r.user_id}`),
					recipient_chat_id:
						user === undefined ? undefined : num(user.telegram_id),
					recipient_role:
						String(ownerId) === String(r.user_id)
							? 'owner'
							: template
								? 'subscriber'
								: 'caregiver',
					channel: 'telegram',
					status: 'sent',
					attempt_generation: 0,
					attempt_count: 1,
					sending_started_at: sentAt,
					sending_lease_expires_at: null,
					retry_at: null,
					retryable: false,
					telegram_bot_id: botId,
					telegram_message_id: num(r.message_id),
					safe_error_json: null,
					sent_at: sentAt,
					failed_at: null,
					unknown_at: null,
					created_at: sentAt,
					updated_at: sentAt,
				},
			);
		}
		for (const r of snapshot.sessions)
			warnings.push({
				code: 'conversation-state-not-migrated',
				table: 'sessions',
				sourceKey: id(r),
				message: 'Conversation state is excluded',
			});
		warnings.push({
			code: 'bullmq-jobs-not-migrated',
			table: 'bullmq',
			sourceKey: '-',
			message: 'Legacy Redis jobs are excluded',
		});
		return { fingerprint, rows, rounding, warnings };
	});
const canonicalize = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(canonicalize)
		: value !== null && typeof value === 'object'
			? Object.fromEntries(
					Object.entries(value as Record<string, unknown>)
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([key, child]) => [key, canonicalize(child)]),
				)
			: value;
export const canonicalDigest = (value: unknown) =>
	Effect.sync(() =>
		createHash('sha256')
			.update(JSON.stringify(canonicalize(value)))
			.digest('hex'),
	);
