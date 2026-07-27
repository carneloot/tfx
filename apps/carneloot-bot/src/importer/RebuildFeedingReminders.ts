import * as PgClient from '@effect/sql-pg/PgClient';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import { BotId, PetId, UserId } from '../domain/Ids.js';
import { FoodEntryId } from '../domain/pet-food/PetFood.js';
import { ReminderScheduler } from '../ports/ReminderScheduler.js';
const Row = Schema.Struct({
	bot_id: BotId,
	owner_id: UserId,
	pet_id: PetId,
	food_entry_id: FoodEntryId,
	run_at: Schema.Union([
		Schema.DateTimeUtcFromDate,
		Schema.DateTimeUtcFromString,
	]),
});
export const rebuildFeedingReminders = Effect.gen(function* () {
	const sql = yield* PgClient.PgClient;
	const scheduler = yield* ReminderScheduler;
	const rows = yield* sql<
		Record<string, unknown>
	>`SELECT i.bot_id,p.owner_id,f.pet_id,f.id food_entry_id,f.fed_at + (s.reminder_delay_ms * interval '1 millisecond') run_at FROM carneloot.pet_food_settings s JOIN carneloot.pets p ON p.id=s.pet_id JOIN carneloot.telegram_identities i ON i.user_id=p.owner_id JOIN LATERAL (SELECT id,pet_id,fed_at FROM carneloot.pet_food_entries WHERE pet_id=p.id ORDER BY fed_at DESC,created_at DESC,id DESC LIMIT 1) f ON true WHERE s.reminder_delay_ms IS NOT NULL ORDER BY f.pet_id`;
	for (const raw of rows) {
		const row = yield* Schema.decodeUnknownEffect(Row)(raw);
		yield* scheduler.replaceForLatest({
			botId: row.bot_id,
			ownerUserId: row.owner_id,
			petId: row.pet_id,
			foodEntryId: row.food_entry_id,
			runAt: row.run_at,
		});
	}
});
