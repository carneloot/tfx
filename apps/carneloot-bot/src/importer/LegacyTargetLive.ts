/* eslint-disable @typescript-eslint/consistent-type-assertions */
import * as PgClient from '@effect/sql-pg/PgClient';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Ref from 'effect/Ref';
import type { SqlError } from 'effect/unstable/sql/SqlError';

import { LegacyImportError } from './LegacyImportError.js';
import { canonicalDigest, type MappedRow } from './LegacyMapping.js';
import { LegacyTarget, type PromotionResult } from './LegacyTarget.js';

class DryRunRollback extends Data.TaggedError('DryRunRollback')<{}> {}

const batchSize = 500;
const targetTables = [
	'users',
	'telegram_identities',
	'pets',
	'pet_caregivers',
	'pet_food_settings',
	'pet_food_entries',
	'api_keys',
	'notification_templates',
	'notification_subscriptions',
	'notification_events',
	'notification_deliveries',
] as const;
type TargetTable = (typeof targetTables)[number];
type PreparedRow = { readonly row: MappedRow; readonly digest: string };
type LedgerRow = {
	readonly source_key: string;
	readonly row_digest: string;
	readonly target_table: string;
	readonly target_key: string;
};

const mappedTimestampFields = new Set([
	'created_at',
	'updated_at',
	'fed_at',
	'scheduled_for',
	'completed_at',
	'cancelled_at',
	'sending_started_at',
	'sending_lease_expires_at',
	'retry_at',
	'sent_at',
	'failed_at',
	'unknown_at',
]);

export const normalizeTargetForComparison = (
	mapped: Readonly<Record<string, unknown>>,
	target: Readonly<Record<string, unknown>>,
) =>
	Object.fromEntries(
		Object.keys(mapped).map((key) => {
			const value = target[key];
			if (!mappedTimestampFields.has(key) || typeof value !== 'string')
				return [key, value];
			const timestamp = new Date(value);
			return [
				key,
				Number.isNaN(timestamp.valueOf()) ? value : timestamp.toISOString(),
			];
		}),
	);

const chunks = <A>(rows: ReadonlyArray<A>) =>
	Array.from({ length: Math.ceil(rows.length / batchSize) }, (_, index) =>
		rows.slice(index * batchSize, (index + 1) * batchSize),
	);

const failure = (cause: unknown) =>
	cause instanceof LegacyImportError
		? cause
		: new LegacyImportError({
				reason: 'TargetUnavailable',
				message: 'Legacy target promotion failed',
				cause,
			});

const targetMismatch = (row: MappedRow) =>
	new LegacyImportError({
		reason: 'Blocked',
		message: `Target row for ${row.sourceTable}/${row.sourceKey} is missing or differs from deterministic import data.`,
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
			'The stored deterministic mapping differs from the current source row or importer mapping.',
			'Reset the target import data or use a new source ID before rerunning.',
		].join(' '),
	});

export const layer = Layer.effect(
	LegacyTarget,
	Effect.map(PgClient.PgClient, (sql) => {
		const insertTargetRows = (
			targetTable: TargetTable,
			rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
		) => {
			const values = rows as any;
			switch (targetTable) {
				case 'users':
					return sql`INSERT INTO carneloot.users ${sql.insert(values)}`;
				case 'telegram_identities':
					return sql`INSERT INTO carneloot.telegram_identities ${sql.insert(values)}`;
				case 'pets':
					return sql`INSERT INTO carneloot.pets ${sql.insert(values)}`;
				case 'pet_caregivers':
					return sql`INSERT INTO carneloot.pet_caregivers ${sql.insert(values)}`;
				case 'pet_food_settings':
					return sql`INSERT INTO carneloot.pet_food_settings ${sql.insert(values)}`;
				case 'pet_food_entries':
					return sql`INSERT INTO carneloot.pet_food_entries ${sql.insert(values)}`;
				case 'api_keys':
					return sql`INSERT INTO carneloot.api_keys ${sql.insert(values)}`;
				case 'notification_templates':
					return sql`INSERT INTO carneloot.notification_templates ${sql.insert(values)}`;
				case 'notification_subscriptions':
					return sql`INSERT INTO carneloot.notification_subscriptions ${sql.insert(values)}`;
				case 'notification_events':
					return sql`INSERT INTO carneloot.notification_events ${sql.insert(values)}`;
				case 'notification_deliveries':
					return sql`INSERT INTO carneloot.notification_deliveries ${sql.insert(values)}`;
			}
		};

		const jsonbArrayKey = (...values: ReadonlyArray<unknown>) =>
			`[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
		const targetRowKey = (
			targetTable: TargetTable,
			value: Record<string, any>,
		) => {
			switch (targetTable) {
				case 'telegram_identities':
					return jsonbArrayKey(value.bot_id, value.telegram_user_id);
				case 'pet_caregivers':
					return jsonbArrayKey(value.pet_id, value.caregiver_user_id);
				case 'notification_subscriptions':
					return jsonbArrayKey(value.template_id, value.user_id);
				case 'pet_food_settings':
					return jsonbArrayKey(value.pet_id);
				default:
					return jsonbArrayKey(value.id);
			}
		};
		const findTargetRows = (
			targetTable: TargetTable,
			rows: ReadonlyArray<MappedRow>,
		): Effect.Effect<
			ReadonlyArray<{ readonly row: Record<string, unknown> }>,
			SqlError
		> => {
			switch (targetTable) {
				case 'users':
					return sql`SELECT to_jsonb(t) row FROM carneloot.users t WHERE id IN ${sql.in(rows.map((row) => (row.value as any).id))} FOR UPDATE`;
				case 'telegram_identities': {
					const values = sql.csv(
						rows.map((row) => {
							const value = row.value as any;
							return sql`(${value.bot_id}::text, ${value.telegram_user_id}::bigint)`;
						}),
					);
					return sql`SELECT to_jsonb(t) row FROM carneloot.telegram_identities t WHERE (t.bot_id,t.telegram_user_id) IN (VALUES ${values}) FOR UPDATE`;
				}
				case 'pets':
					return sql`SELECT to_jsonb(t) row FROM carneloot.pets t WHERE id IN ${sql.in(rows.map((row) => (row.value as any).id))} FOR UPDATE`;
				case 'pet_caregivers': {
					const values = sql.csv(
						rows.map((row) => {
							const value = row.value as any;
							return sql`(${value.pet_id}::uuid, ${value.caregiver_user_id}::uuid)`;
						}),
					);
					return sql`SELECT to_jsonb(t) row FROM carneloot.pet_caregivers t WHERE (t.pet_id,t.caregiver_user_id) IN (VALUES ${values}) FOR UPDATE`;
				}
				case 'pet_food_settings':
					return sql`SELECT to_jsonb(t) row FROM carneloot.pet_food_settings t WHERE pet_id IN ${sql.in(rows.map((row) => (row.value as any).pet_id))} FOR UPDATE`;
				case 'pet_food_entries':
					return sql`SELECT to_jsonb(t) row FROM carneloot.pet_food_entries t WHERE id IN ${sql.in(rows.map((row) => (row.value as any).id))} FOR UPDATE`;
				case 'api_keys':
					return sql`SELECT to_jsonb(t) row FROM carneloot.api_keys t WHERE id IN ${sql.in(rows.map((row) => (row.value as any).id))} FOR UPDATE`;
				case 'notification_templates':
					return sql`SELECT to_jsonb(t) row FROM carneloot.notification_templates t WHERE id IN ${sql.in(rows.map((row) => (row.value as any).id))} FOR UPDATE`;
				case 'notification_subscriptions': {
					const values = sql.csv(
						rows.map((row) => {
							const value = row.value as any;
							return sql`(${value.template_id}::uuid, ${value.user_id}::uuid)`;
						}),
					);
					return sql`SELECT to_jsonb(t) row FROM carneloot.notification_subscriptions t WHERE (t.template_id,t.user_id) IN (VALUES ${values}) FOR UPDATE`;
				}
				case 'notification_events':
					return sql`SELECT to_jsonb(t) row FROM carneloot.notification_events t WHERE id IN ${sql.in(rows.map((row) => (row.value as any).id))} FOR UPDATE`;
				case 'notification_deliveries':
					return sql`SELECT to_jsonb(t) row FROM carneloot.notification_deliveries t WHERE id IN ${sql.in(rows.map((row) => (row.value as any).id))} FOR UPDATE`;
			}
		};
		const targetDigest = (row: MappedRow, target: Record<string, unknown>) =>
			canonicalDigest(normalizeTargetForComparison(row.value, target));

		return LegacyTarget.of({
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
									existing: Record<string, number> = {},
									importedAt = new Date();

								for (const targetTable of targetTables) {
									const targetRows = mapped.rows.filter(
										(row) => row.targetTable === targetTable,
									);
									const bySourceTable = new Map<string, MappedRow[]>();
									for (const row of targetRows) {
										const rows = bySourceTable.get(row.sourceTable) ?? [];
										rows.push(row);
										bySourceTable.set(row.sourceTable, rows);
									}
									const newTargets: PreparedRow[] = [];
									const newLedgers: PreparedRow[] = [];
									const plannedTargets = new Map<
										string,
										Record<string, unknown>
									>();

									for (const [sourceTable, sourceRows] of bySourceTable) {
										const pendingLedgers = new Map<string, LedgerRow>();
										for (const sourceBatch of chunks(sourceRows)) {
											const prepared: PreparedRow[] = [];
											for (const row of sourceBatch)
												prepared.push({
													row,
													digest: yield* canonicalDigest(row.value),
												});
											const ledgers =
												yield* sql<LedgerRow>`SELECT source_key,row_digest,target_table,target_key FROM carneloot.legacy_import_ledger WHERE source_fingerprint=${mapped.fingerprint} AND source_table=${sourceTable} AND target_table=${targetTable} AND source_key IN ${sql.in(sourceBatch.map((row) => row.sourceKey))} FOR UPDATE`;
											const ledgerBySourceKey = new Map([
												...pendingLedgers,
												...ledgers.map(
													(ledger) => [ledger.source_key, ledger] as const,
												),
											]);
											const targetByKey = new Map(
												(yield* findTargetRows(targetTable, sourceBatch)).map(
													(target) => [
														targetRowKey(
															targetTable,
															target.row as Record<string, any>,
														),
														target.row,
													],
												),
											);

											for (const item of prepared) {
												const ledger = ledgerBySourceKey.get(
													item.row.sourceKey,
												);
												if (
													ledger &&
													(ledger.row_digest !== item.digest ||
														ledger.target_table !== item.row.targetTable ||
														ledger.target_key !== item.row.targetKey)
												)
													return yield* Effect.fail(
														ledgerMismatch(item.row, ledger),
													);
												const key = targetRowKey(
													targetTable,
													item.row.value as Record<string, any>,
												);
												const target =
													targetByKey.get(key) ?? plannedTargets.get(key);
												if (ledger) {
													if (
														target === undefined ||
														(yield* targetDigest(item.row, target)) !==
															item.digest
													)
														return yield* Effect.fail(targetMismatch(item.row));
													existing[item.row.sourceTable] =
														(existing[item.row.sourceTable] ?? 0) + 1;
													continue;
												}
												const newLedger = {
													source_key: item.row.sourceKey,
													row_digest: item.digest,
													target_table: item.row.targetTable,
													target_key: item.row.targetKey,
												};
												ledgerBySourceKey.set(item.row.sourceKey, newLedger);
												pendingLedgers.set(item.row.sourceKey, newLedger);
												newLedgers.push(item);
												if (target !== undefined) {
													if (
														(yield* targetDigest(item.row, target)) !==
														item.digest
													)
														return yield* Effect.fail(targetMismatch(item.row));
													existing[item.row.sourceTable] =
														(existing[item.row.sourceTable] ?? 0) + 1;
													continue;
												}
												plannedTargets.set(key, item.row.value);
												newTargets.push(item);
												inserted[item.row.sourceTable] =
													(inserted[item.row.sourceTable] ?? 0) + 1;
											}
										}
									}

									for (const batch of chunks(newTargets))
										yield* insertTargetRows(
											targetTable,
											batch.map((item) => item.row.value),
										);
									for (const batch of chunks(newLedgers))
										yield* sql`INSERT INTO carneloot.legacy_import_ledger ${sql.insert(
											batch.map((item) => ({
												source_fingerprint: mapped.fingerprint,
												source_table: item.row.sourceTable,
												source_key: item.row.sourceKey,
												target_table: item.row.targetTable,
												target_key: item.row.targetKey,
												row_digest: item.digest,
												imported_at: importedAt,
											})),
										)}`;
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
		});
	}),
);
