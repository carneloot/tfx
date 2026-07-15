import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import {
	ReminderScheduler,
	type ReminderSchedulerService,
} from '../../../src/ports/ReminderScheduler.js';

export const layer: Layer.Layer<ReminderScheduler, never, PgClient.PgClient> =
	Layer.effect(
		ReminderScheduler,
		Effect.map(PgClient.PgClient, (sql) => {
			const service: ReminderSchedulerService = {
				replaceForLatest: (schedule) =>
					sql`INSERT INTO carneloot.test_reminder_actions (kind,pet_id,food_entry_id,run_at) VALUES ('replace',${schedule.petId}::uuid,${schedule.foodEntryId}::uuid,${new Date(schedule.runAt)})`.pipe(
						Effect.asVoid,
					),
				cancelForPet: (petId) =>
					sql`INSERT INTO carneloot.test_reminder_actions (kind,pet_id) VALUES ('cancel',${petId}::uuid)`.pipe(
						Effect.asVoid,
					),
			};
			return service;
		}),
	);
