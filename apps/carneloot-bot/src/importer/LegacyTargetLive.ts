/* eslint-disable @typescript-eslint/consistent-type-assertions */
import * as PgClient from '@effect/sql-pg/PgClient';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Ref from 'effect/Ref';

import { LegacyImportError } from './LegacyImportError.js';
import { canonicalDigest } from './LegacyMapping.js';
import { LegacyTarget, type PromotionResult } from './LegacyTarget.js';
class DryRunRollback extends Data.TaggedError('DryRunRollback')<{}> {}

const failure = (cause: unknown) =>
	cause instanceof LegacyImportError
		? cause
		: new LegacyImportError({
				reason: 'TargetUnavailable',
				message: 'Legacy target promotion failed',
				cause,
			});

const ledgerMismatch = (
	row: {
		readonly sourceTable: string;
		readonly sourceKey: string;
		readonly targetTable: string;
		readonly targetKey: string;
	},
	ledger: { readonly target_table: string; readonly target_key: string },
) =>
	new LegacyImportError({
		reason: 'Blocked',
		message: [
			`Legacy ledger collision for ${row.sourceTable}/${row.sourceKey}.`,
			`Existing ledger target: ${ledger.target_table}/${ledger.target_key}.`,
			`Current mapped target: ${row.targetTable}/${row.targetKey}.`,
			'One legacy source row maps to multiple target records, but legacy_import_ledger currently keys only source rows.',
			'Change the ledger primary key to include target_table, then rerun against a fresh target.',
		].join(' '),
	});

export const layer = Layer.effect(
	LegacyTarget,
	Effect.map(PgClient.PgClient, (sql) =>
		LegacyTarget.of({
			promote: (mapped, options) =>
				Effect.gen(function* () {
					const dryRunResult = yield* Ref.make<PromotionResult | undefined>(
						undefined,
					);
					return yield* sql
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
										target_table: string;
										target_key: string;
									}>`SELECT row_digest,target_table,target_key FROM carneloot.legacy_import_ledger WHERE source_fingerprint=${mapped.fingerprint} AND source_table=${row.sourceTable} AND source_key=${row.sourceKey} AND target_table=${row.targetTable} FOR UPDATE`;
									if (ledger[0]) {
										if (
											ledger[0].row_digest !== digest ||
											ledger[0].target_table !== row.targetTable ||
											ledger[0].target_key !== row.targetKey
										)
											return yield* Effect.fail(ledgerMismatch(row, ledger[0]));
										existing[row.sourceTable] =
											(existing[row.sourceTable] ?? 0) + 1;
										continue;
									}
									const v = row.value as any;
									switch (row.targetTable) {
										case 'users':
											yield* sql`INSERT INTO carneloot.users(id,created_at,updated_at) VALUES(${v.id}::uuid,${v.created_at},${v.updated_at})`;
											break;
										case 'telegram_identities':
											yield* sql`INSERT INTO carneloot.telegram_identities(bot_id,telegram_user_id,user_id,username,first_name,last_name,private_chat_id,created_at,updated_at) VALUES(${v.bot_id},${v.telegram_user_id},${v.user_id}::uuid,${v.username},${v.first_name},${v.last_name},${v.private_chat_id},${v.created_at},${v.updated_at})`;
											break;
										case 'pets':
											yield* sql`INSERT INTO carneloot.pets(id,owner_id,name,name_key,created_at,updated_at) VALUES(${v.id}::uuid,${v.owner_id}::uuid,${v.name},${v.name_key},${v.created_at},${v.updated_at})`;
											break;
										case 'pet_caregivers':
											yield* sql`INSERT INTO carneloot.pet_caregivers(pet_id,caregiver_user_id,status,created_at,updated_at) VALUES(${v.pet_id}::uuid,${v.caregiver_user_id}::uuid,${v.status},${v.created_at},${v.updated_at})`;
											break;
										case 'pet_food_settings':
											yield* sql`INSERT INTO carneloot.pet_food_settings(pet_id,day_start,timezone,reminder_delay_ms,created_at,updated_at) VALUES(${v.pet_id}::uuid,${v.day_start},${v.timezone},${v.reminder_delay_ms},${v.created_at},${v.updated_at})`;
											break;
										case 'pet_food_entries':
											yield* sql`INSERT INTO carneloot.pet_food_entries(id,pet_id,recorded_by,amount_mg,fed_at,source_bot_id,source_update_id,source_message_chat_id,source_message_id,created_at,updated_at) VALUES(${v.id}::uuid,${v.pet_id}::uuid,${v.recorded_by}::uuid,${v.amount_mg},${v.fed_at},${v.source_bot_id},${v.source_update_id},${v.source_message_chat_id},${v.source_message_id},${v.created_at},${v.updated_at})`;
											break;
										case 'api_keys':
											yield* sql`INSERT INTO carneloot.api_keys(id,user_id,key_hash,created_at,updated_at) VALUES(${v.id}::uuid,${v.user_id}::uuid,${v.key_hash},${v.created_at},${v.updated_at})`;
											break;
										case 'notification_templates':
											yield* sql`INSERT INTO carneloot.notification_templates(id,owner_user_id,keyword,message,created_at,updated_at) VALUES(${v.id}::uuid,${v.owner_user_id}::uuid,${v.keyword},${v.message},${v.created_at},${v.updated_at})`;
											break;
										case 'notification_subscriptions':
											yield* sql`INSERT INTO carneloot.notification_subscriptions(template_id,user_id,created_at) VALUES(${v.template_id}::uuid,${v.user_id}::uuid,${v.created_at})`;
											break;
										case 'notification_events':
											yield* sql`INSERT INTO carneloot.notification_events(id,bot_id,kind,owner_user_id,pet_id,food_entry_id,scheduled_for,status,dedupe_key,job_id,created_at,updated_at,completed_at,cancelled_at) VALUES(${v.id}::uuid,${v.bot_id},${v.kind},${v.owner_user_id}::uuid,${v.pet_id}::uuid,${v.food_entry_id}::uuid,${v.scheduled_for},${v.status},${v.dedupe_key},${v.job_id}::uuid,${v.created_at},${v.updated_at},${v.completed_at},${v.cancelled_at})`;
											break;
										case 'notification_deliveries':
											yield* sql`INSERT INTO carneloot.notification_deliveries(id,event_id,recipient_user_id,recipient_chat_id,recipient_role,channel,status,attempt_generation,attempt_count,sending_started_at,sending_lease_expires_at,retry_at,retryable,telegram_bot_id,telegram_message_id,safe_error_json,sent_at,failed_at,unknown_at,created_at,updated_at) VALUES(${v.id}::uuid,${v.event_id}::uuid,${v.recipient_user_id}::uuid,${v.recipient_chat_id},${v.recipient_role},${v.channel},${v.status},${v.attempt_generation},${v.attempt_count},${v.sending_started_at},${v.sending_lease_expires_at},${v.retry_at},${v.retryable},${v.telegram_bot_id},${v.telegram_message_id},${v.safe_error_json},${v.sent_at},${v.failed_at},${v.unknown_at},${v.created_at},${v.updated_at})`;
											break;
									}
									yield* sql`INSERT INTO carneloot.legacy_import_ledger(source_fingerprint,source_table,source_key,target_table,target_key,row_digest,imported_at) VALUES(${mapped.fingerprint},${row.sourceTable},${row.sourceKey},${row.targetTable},${row.targetKey},${digest},now())`;
									inserted[row.sourceTable] =
										(inserted[row.sourceTable] ?? 0) + 1;
								}
								const result = { inserted, existing };
								if (options.dryRun) {
									yield* Ref.set(dryRunResult, result);
									return yield* Effect.fail(new DryRunRollback());
								}
								return result;
							}),
						)
						.pipe(
							Effect.catchTag('DryRunRollback', () =>
								Effect.flatMap(Ref.get(dryRunResult), (result) =>
									result === undefined
										? Effect.die(new Error('Missing dry-run promotion result'))
										: Effect.succeed(result),
								),
							),
							Effect.mapError(failure),
						);
				}),
		}),
	),
);
