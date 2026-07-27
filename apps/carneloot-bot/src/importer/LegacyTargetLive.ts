/* eslint-disable @typescript-eslint/consistent-type-assertions */
import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import { LegacyImportError } from './LegacyImportError.js';
import { canonicalDigest } from './LegacyMapping.js';
import { LegacyTarget } from './LegacyTarget.js';
const failure = (cause: unknown) =>
	new LegacyImportError({
		reason: 'TargetUnavailable',
		message: 'Legacy target promotion failed',
		cause,
	});
export const layer = Layer.effect(
	LegacyTarget,
	Effect.map(PgClient.PgClient, (sql) =>
		LegacyTarget.of({
			promote: (mapped) =>
				sql
					.withTransaction(
						Effect.gen(function* () {
							yield* sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`;
							yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${'carneloot:legacy-import:' + mapped.fingerprint},0))`;
							const inserted: Record<string, number> = {},
								existing: Record<string, number> = {};
							for (const row of mapped.rows) {
								const digest = yield* canonicalDigest(row.value);
								const ledger = yield* sql<{
									row_digest: string;
								}>`SELECT row_digest FROM carneloot.legacy_import_ledger WHERE source_fingerprint=${mapped.fingerprint} AND source_table=${row.sourceTable} AND source_key=${row.sourceKey} FOR UPDATE`;
								if (ledger[0]) {
									if (ledger[0].row_digest !== digest)
										return yield* Effect.fail(
											failure('Source row changed after import'),
										);
									existing[row.sourceTable] =
										(existing[row.sourceTable] ?? 0) + 1;
									continue;
								}
								const v = row.value as any;
								switch (row.targetTable) {
									case 'users':
										yield* sql`INSERT INTO carneloot.users(id,created_at,updated_at) VALUES(${v.id}::uuid,${v.created_at},${v.updated_at}) ON CONFLICT DO NOTHING`;
										break;
									case 'telegram_identities':
										yield* sql`INSERT INTO carneloot.telegram_identities(bot_id,telegram_user_id,user_id,username,first_name,last_name,private_chat_id,created_at,updated_at) VALUES(${v.bot_id},${v.telegram_user_id},${v.user_id}::uuid,${v.username},${v.first_name},${v.last_name},${v.private_chat_id},${v.created_at},${v.updated_at}) ON CONFLICT DO NOTHING`;
										break;
									case 'pets':
										yield* sql`INSERT INTO carneloot.pets(id,owner_id,name,name_key,created_at,updated_at) VALUES(${v.id}::uuid,${v.owner_id}::uuid,${v.name},${v.name_key},${v.created_at},${v.updated_at}) ON CONFLICT DO NOTHING`;
										break;
									case 'pet_caregivers':
										yield* sql`INSERT INTO carneloot.pet_caregivers(pet_id,caregiver_user_id,status,created_at,updated_at) VALUES(${v.pet_id}::uuid,${v.caregiver_user_id}::uuid,${v.status},${v.created_at},${v.updated_at}) ON CONFLICT DO NOTHING`;
										break;
									case 'pet_food_entries':
										yield* sql`INSERT INTO carneloot.pet_food_entries(id,pet_id,recorded_by,amount_mg,fed_at,source_bot_id,source_update_id,source_message_chat_id,source_message_id,created_at,updated_at) VALUES(${v.id}::uuid,${v.pet_id}::uuid,${v.recorded_by}::uuid,${v.amount_mg},${v.fed_at},${v.source_bot_id},${v.source_update_id},${v.source_message_chat_id},${v.source_message_id},${v.created_at},${v.updated_at}) ON CONFLICT DO NOTHING`;
										break;
									case 'api_keys':
										yield* sql`INSERT INTO carneloot.api_keys(id,user_id,key_hash,created_at,updated_at) VALUES(${v.id}::uuid,${v.user_id}::uuid,${v.key_hash},${v.created_at},${v.updated_at}) ON CONFLICT DO NOTHING`;
										break;
									case 'notification_templates':
										yield* sql`INSERT INTO carneloot.notification_templates(id,owner_user_id,keyword,message,created_at,updated_at) VALUES(${v.id}::uuid,${v.owner_user_id}::uuid,${v.keyword},${v.message},${v.created_at},${v.updated_at}) ON CONFLICT DO NOTHING`;
										break;
									case 'notification_subscriptions':
										yield* sql`INSERT INTO carneloot.notification_subscriptions(template_id,user_id,created_at) VALUES(${v.template_id}::uuid,${v.user_id}::uuid,${v.created_at}) ON CONFLICT DO NOTHING`;
										break;
								}
								yield* sql`INSERT INTO carneloot.legacy_import_ledger(source_fingerprint,source_table,source_key,target_table,target_key,row_digest,imported_at) VALUES(${mapped.fingerprint},${row.sourceTable},${row.sourceKey},${row.targetTable},${row.targetKey},${digest},now())`;
								inserted[row.sourceTable] =
									(inserted[row.sourceTable] ?? 0) + 1;
							}
							return { inserted, existing };
						}),
					)
					.pipe(Effect.mapError(failure)),
		}),
	),
);
