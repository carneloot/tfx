import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import { InvalidDomainInput } from '../domain/DomainError.js';
import { BotId, TelegramChatId } from '../domain/Ids.js';
import type { FoodAmount } from '../domain/pet-food/FoodAmount.js';
import * as FoodDateTime from '../domain/pet-food/FoodDateTime.js';
import { FoodEntryId } from '../domain/pet-food/PetFood.js';
import {
	DuplicateFoodEntry,
	PetFoodSetupMissing,
} from '../domain/pet-food/PetFoodError.js';
import { FoodNotificationScheduler } from '../ports/FoodNotificationScheduler.js';
import { PetFoodRepository } from '../ports/PetFoodRepository.js';
import { ReminderScheduler } from '../ports/ReminderScheduler.js';
import { authorize, type PetFoodAccess } from './PetFoodAccess.js';

export interface ParsedFoodInput {
	readonly amountMg: FoodAmount;
	readonly when: string;
	readonly messageDate: DateTime.Utc;
}

export interface SourceInput {
	readonly botId: unknown;
	readonly updateId: unknown;
	readonly messageChatId?: unknown;
	readonly messageId?: unknown;
}
const safeUpdateId = Schema.Number.check(
	Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0),
);
const safeMessageId = Schema.Number.check(
	Schema.makeFilter((value) => Number.isSafeInteger(value) && value > 0),
);
const invalid = (message: string, cause: unknown) =>
	new InvalidDomainInput({ message, cause });

export const execute = (
	access: PetFoodAccess,
	input: ParsedFoodInput,
	sourceInput: SourceInput,
) =>
	Effect.gen(function* () {
		const source = {
			botId: yield* Schema.decodeUnknownEffect(BotId)(sourceInput.botId).pipe(
				Effect.mapError((cause) => invalid('Invalid source bot', cause)),
			),
			updateId: yield* Schema.decodeUnknownEffect(safeUpdateId)(
				sourceInput.updateId,
			).pipe(Effect.mapError((cause) => invalid('Invalid update id', cause))),
			messageChatId:
				sourceInput.messageChatId === undefined
					? null
					: yield* Schema.decodeUnknownEffect(TelegramChatId)(
							sourceInput.messageChatId,
						).pipe(
							Effect.mapError((cause) =>
								invalid('Invalid source chat id', cause),
							),
						),
			messageId:
				sourceInput.messageId === undefined
					? null
					: yield* Schema.decodeUnknownEffect(safeMessageId)(
							sourceInput.messageId,
						).pipe(
							Effect.mapError((cause) =>
								invalid('Invalid source message id', cause),
							),
						),
		};
		if (source.botId !== access.botId)
			return yield* Effect.fail(
				invalid('Source bot does not match authenticated bot', source.botId),
			);
		const sql = yield* PgClient.PgClient;
		const repository = yield* PetFoodRepository;
		const scheduler = yield* ReminderScheduler;
		const foodNotifications = yield* FoodNotificationScheduler;
		const result = yield* sql.withTransaction(
			Effect.gen(function* () {
				const authorized = yield* authorize(access);
				const replay = yield* repository.findBySource(
					access.petId,
					source.botId,
					source.updateId,
				);
				if (replay !== undefined) {
					const settings = yield* repository.getSettings(access.petId);
					const latest = yield* repository.latestEntry(access.petId);
					return {
						entry: replay,
						replayed: true,
						latest: latest?.id === replay.id,
						timeZone: settings?.timeZone ?? null,
					};
				}
				const settings = yield* repository.getSettings(access.petId);
				if (
					settings === undefined ||
					settings.dayStart === null ||
					settings.timeZone === null
				)
					return yield* Effect.fail(
						new PetFoodSetupMissing({
							message: 'Pet day start is not configured',
						}),
					);
				const now = yield* DateTime.now;
				const fedAt =
					input.when.length === 0
						? input.messageDate
						: yield* FoodDateTime.parse(
								input.when,
								settings.timeZone,
								input.messageDate,
							);
				const duplicate = yield* repository.findBusinessDuplicate(
					access.petId,
					fedAt,
				);
				if (duplicate !== undefined)
					return yield* Effect.fail(
						new DuplicateFoodEntry({
							message: 'A food entry already exists within one minute',
						}),
					);
				const id = Schema.decodeUnknownSync(FoodEntryId)(crypto.randomUUID());
				const entry = yield* repository.insert({
					id,
					petId: access.petId,
					recordedBy: authorized.actorId,
					amountMg: input.amountMg,
					fedAt,
					source,
					now,
				});
				const latest = yield* repository.latestEntry(access.petId);
				const isLatest = latest?.id === entry.id;
				if (isLatest && settings.reminderDelay !== null)
					yield* scheduler.replaceForLatest({
						botId: access.botId,
						ownerUserId: authorized.ownerId,
						petId: access.petId,
						foodEntryId: entry.id,
						runAt: DateTime.addDuration(entry.fedAt, settings.reminderDelay),
					});
				yield* foodNotifications.scheduleAdded({
					botId: access.botId,
					ownerUserId: authorized.ownerId,
					actorUserId: authorized.actorId,
					petId: access.petId,
					foodEntryId: entry.id,
					sourceUpdateId: source.updateId,
					timestampExplicit: input.when.length > 0,
				});
				return {
					entry,
					replayed: false,
					latest: isLatest,
					timeZone: settings.timeZone,
				};
			}),
		);
		yield* Effect.logInfo(
			result.replayed ? 'carneloot.food.replayed' : 'carneloot.food.recorded',
		).pipe(
			Effect.annotateLogs({
				actorId: access.actorId,
				petId: access.petId,
				foodEntryId: result.entry.id,
				latest: result.latest,
			}),
		);
		return result;
	});
