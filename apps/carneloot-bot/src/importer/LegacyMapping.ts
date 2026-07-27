import * as Crypto from 'effect/Crypto';
import * as Effect from 'effect/Effect';
/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/consistent-type-assertions */
import { createHash } from 'node:crypto';

import { legacyId } from './LegacyId.js';
import type { LegacyRow, LegacySnapshot } from './LegacySchemas.js';

export interface MappedRow {
	readonly sourceTable: string;
	readonly sourceKey: string;
	readonly targetTable: string;
	readonly targetKey: string;
	readonly value: Readonly<Record<string, unknown>>;
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
const updateId = (digest: Uint8Array) => {
	let n = 0;
	for (const b of digest.slice(0, 7)) n = n * 256 + b;
	return n & 0x1fffffffffffff;
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
		] as const)
			for (const row of snapshot[table])
				ids.set(
					`${table}:${id(row)}`,
					yield* legacyId(fingerprint, table, id(row)),
				);
		const rows: MappedRow[] = [];
		const rounding: RoundingNotice[] = [];
		const warnings: MappedLegacy['warnings'][number][] = [];
		const add = (
			sourceTable: string,
			sourceKey: string,
			targetTable: string,
			targetKey: string,
			value: Record<string, unknown>,
		) => rows.push({ sourceTable, sourceKey, targetTable, targetKey, value });
		for (const r of snapshot.users) {
			const telegram = num(r.telegram_id);
			const uid = ids.get(`users:${id(r)}`)!;
			add('users', id(r), 'users', uid, {
				id: uid,
				created_at: importedAt.toISOString(),
				updated_at: importedAt.toISOString(),
			});
			add('users', id(r), 'telegram_identities', `${botId}:${telegram}`, {
				bot_id: botId,
				telegram_user_id: telegram,
				user_id: uid,
				username: r.username,
				first_name: r.first_name,
				last_name: r.last_name,
				private_chat_id: telegram,
				created_at: importedAt.toISOString(),
				updated_at: importedAt.toISOString(),
			});
		}
		for (const r of snapshot.pets) {
			const pid = ids.get(`pets:${id(r)}`)!;
			add('pets', id(r), 'pets', pid, {
				id: pid,
				owner_id: ids.get(`users:${r.owner_id}`),
				name: r.name,
				name_key: String(r.name)
					.normalize('NFKC')
					.trim()
					.toLocaleLowerCase('pt-BR'),
				created_at: importedAt.toISOString(),
				updated_at: importedAt.toISOString(),
			});
		}
		for (const r of snapshot.pet_carers) {
			const petId = ids.get(`pets:${r.pet_id}`),
				userId = ids.get(`users:${r.carer_id}`);
			add('pet_carers', id(r), 'pet_caregivers', `${petId}:${userId}`, {
				pet_id: petId,
				caregiver_user_id: userId,
				status: r.status,
				created_at: importedAt.toISOString(),
				updated_at: importedAt.toISOString(),
			});
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
			add('pet_food', id(r), 'pet_food_entries', fid, {
				id: fid,
				pet_id: ids.get(`pets:${r.pet_id}`),
				recorded_by: ids.get(`users:${r.user_id}`),
				amount_mg: amount,
				fed_at: date(r.time),
				source_bot_id: botId,
				source_update_id: updateId(digest),
				source_message_chat_id:
					message === null ? null : num(actor?.telegram_id),
				source_message_id: message,
				created_at: importedAt.toISOString(),
				updated_at: importedAt.toISOString(),
			});
		}
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
			add('notifications', id(r), 'notification_templates', nid, {
				id: nid,
				owner_user_id: ids.get(`users:${r.owner_id}`),
				keyword: r.keyword,
				message: r.message,
				created_at: importedAt.toISOString(),
				updated_at: importedAt.toISOString(),
			});
		}
		for (const r of snapshot.users_to_notify) {
			const key = `${ids.get(`notifications:${r.notification_id}`)}:${ids.get(`users:${r.user_id}`)}`;
			add('users_to_notify', id(r), 'notification_subscriptions', key, {
				template_id: ids.get(`notifications:${r.notification_id}`),
				user_id: ids.get(`users:${r.user_id}`),
				created_at: importedAt.toISOString(),
			});
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
export const canonicalDigest = (value: unknown) =>
	Effect.sync(() =>
		createHash('sha256')
			.update(JSON.stringify(value, Object.keys(value as object).sort()))
			.digest('hex'),
	);
