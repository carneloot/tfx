import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import {
	ReminderScheduler,
	ReminderSchedulerError,
	type ReminderSchedulerService,
} from '../../../src/ports/ReminderScheduler.js';
const mapSql = <A, E, R>(effect: Effect.Effect<A, E, R>, message: string) =>
	effect.pipe(
		Effect.mapError(
			(cause) =>
				new ReminderSchedulerError({
					reason: 'PersistenceFailure',
					message,
					cause,
				}),
		),
	);
export const layer: Layer.Layer<ReminderScheduler, never, PgClient.PgClient> =
	Layer.effect(
		ReminderScheduler,
		Effect.map(PgClient.PgClient, (sql) => {
			const service: ReminderSchedulerService = {
				replaceForLatest: (schedule) =>
					mapSql(
						sql`INSERT INTO carneloot.test_reminder_actions (kind,pet_id,food_entry_id,run_at) VALUES ('replace',${schedule.petId}::uuid,${schedule.foodEntryId}::uuid,${DateTime.toDateUtc(schedule.runAt)})`.pipe(
							Effect.asVoid,
						),
						'Recording scheduler replace failed',
					),
				cancelForPet: (petId) =>
					mapSql(
						sql`INSERT INTO carneloot.test_reminder_actions (kind,pet_id) VALUES ('cancel',${petId}::uuid)`.pipe(
							Effect.asVoid,
						),
						'Recording scheduler cancel failed',
					),
			};
			return service;
		}),
	);
