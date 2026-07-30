import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';

import { DomainPersistenceError } from '../domain/DomainError.js';
import {
	BotId,
	PetId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../domain/Ids.js';
import { FoodAmount } from '../domain/pet-food/FoodAmount.js';
import { PetFoodEntry } from '../domain/pet-food/PetFood.js';
import { PetName } from '../domain/Pet.js';
import { NotificationRepository } from '../ports/NotificationRepository.js';
import * as AddFood from './AddFood.js';
import * as CorrectFoodBySource from './CorrectFoodBySource.js';
import { authorize } from './PetFoodAccess.js';

const PetResult = Schema.Struct({
	id: PetId,
	ownerId: UserId,
	name: PetName,
	createdAt: Schema.DateTimeUtc,
	updatedAt: Schema.DateTimeUtc,
});

export const FoodReplyResult = Schema.Union([
	Schema.TaggedStruct('Unrelated', {}),
	Schema.TaggedStruct('ReminderFoodAdded', {
		entry: PetFoodEntry,
		pet: PetResult,
	}),
	Schema.TaggedStruct('FoodCorrected', {
		entries: Schema.Array(PetFoodEntry),
	}),
	Schema.TaggedStruct('InvalidInput', { message: Schema.String }),
]);
export type FoodReplyResult = typeof FoodReplyResult.Type;

export class FoodReplyLedgerError extends Schema.TaggedErrorClass<FoodReplyLedgerError>()(
	'FoodReplyLedgerError',
	{
		reason: Schema.Literals(['InvalidStoredResult']),
		message: Schema.String,
		cause: Schema.optionalKey(Schema.Unknown),
	},
) {}

export interface RouteFoodReplyInput {
	readonly actorId: UserId;
	readonly botId: BotId;
	readonly telegramUserId: TelegramUserId;
	readonly chatId: TelegramChatId;
	readonly updateId: number;
	readonly messageId: number;
	readonly messageDate: DateTime.Utc;
	readonly repliedMessageId: number;
	readonly text: string;
}

const invalidResult = (message = 'Formato de ração inválido.') =>
	({ _tag: 'InvalidInput', message }) as const;

const splitFoodInput = (input: string) => {
	const trimmed = input.trim();
	if (trimmed.length === 0) return undefined;
	const suffix =
		/^(.*?\S)\s+((?:\d{2}[/-]\d{2}(?:[/-]\d{4})? \d{2}:\d{2})|(?:\d{2}:\d{2}))$/u.exec(
			trimmed,
		);
	return suffix?.[1] !== undefined && suffix[2] !== undefined
		? { amount: suffix[1], when: suffix[2] }
		: { amount: trimmed, when: '' };
};

const decodeStored = (value: unknown) =>
	Schema.decodeUnknownEffect(FoodReplyResult)(value).pipe(
		Effect.mapError(
			(cause) =>
				new FoodReplyLedgerError({
					reason: 'InvalidStoredResult',
					message: 'Stored food reply result is invalid',
					cause,
				}),
		),
	);

const route = (input: RouteFoodReplyInput) =>
	Effect.gen(function* () {
		const notifications = yield* NotificationRepository;
		const reply = yield* notifications
			.findSentByTelegramMessage(
				input.botId,
				input.chatId,
				input.repliedMessageId,
			)
			.pipe(
				Effect.mapError(
					(error) =>
						new DomainPersistenceError({
							reason:
								error.reason === 'PersistenceFailure'
									? 'PersistenceFailure'
									: 'InvariantViolation',
							message: error.message,
							cause: error,
						}),
				),
			);
		if (
			reply?.event.kind === 'feeding-reminder' &&
			reply.delivery.recipientUserId === input.actorId &&
			reply.event.petId !== null
		) {
			const parsed = splitFoodInput(input.text);
			if (parsed === undefined) return invalidResult();
			const amount = yield* Schema.decodeUnknownEffect(FoodAmount)(
				parsed.amount,
			).pipe(Effect.option);
			if (amount._tag === 'None') return invalidResult();
			const access = {
				actorId: input.actorId,
				botId: input.botId,
				telegramUserId: input.telegramUserId,
				petId: reply.event.petId,
			};
			const authorized = yield* authorize(access);
			const added = yield* AddFood.execute(
				access,
				{
					amountMg: amount.value,
					when: parsed.when,
					messageDate: input.messageDate,
				},
				{
					botId: input.botId,
					updateId: input.updateId,
					messageChatId: input.chatId,
					messageId: input.messageId,
				},
			);
			return {
				_tag: 'ReminderFoodAdded',
				entry: added.entry,
				pet: authorized.pet,
			} as const;
		}

		const corrected = yield* CorrectFoodBySource.execute({
			actorId: input.actorId,
			botId: input.botId,
			telegramUserId: input.telegramUserId,
			chatId: input.chatId,
			repliedMessageId: input.repliedMessageId,
			correction: input.text,
			messageDate: input.messageDate,
		});
		return corrected._tag === 'Unrelated'
			? ({ _tag: 'Unrelated' } as const)
			: ({ _tag: 'FoodCorrected', entries: corrected.entries } as const);
	}).pipe(
		Effect.catchTags({
			InvalidDomainInput: () => Effect.succeed(invalidResult()),
			PetAccessDenied: () =>
				Effect.succeed(invalidResult('Ração não acessível.')),
			PetFoodSetupMissing: () =>
				Effect.succeed(invalidResult('Configuração de ração incompleta.')),
			DuplicateFoodEntry: () =>
				Effect.succeed(invalidResult('Essa ração já foi registrada.')),
			PetFoodError: () => Effect.succeed(invalidResult()),
		}),
	);

/** Routes and durably records one reply mutation in the same SQL transaction. */
export const execute = Effect.fn('RouteFoodReply.execute')
	((input: RouteFoodReplyInput) =>
	Effect.gen(function* () {
		const sql = yield* PgClient.PgClient;
		return yield* sql.withTransaction(
			Effect.gen(function* () {
				const lockKey = `food-reply:${input.botId}:${input.updateId}`;
				yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
				const rows = yield* sql<{
					result_json: unknown;
				}>`SELECT result_json FROM carneloot.food_reply_operations WHERE bot_id=${input.botId} AND update_id=${input.updateId}`;
				if (rows[0] !== undefined)
					return yield* decodeStored(rows[0].result_json);

				const result = yield* route(input);
				const encoded = yield* Schema.encodeEffect(FoodReplyResult)(
					result,
				).pipe(Effect.orDie);
				const now = yield* DateTime.now;
				yield* sql`INSERT INTO carneloot.food_reply_operations (bot_id,update_id,kind,result_json,created_at) VALUES (${input.botId},${input.updateId},${result._tag},${sql.json(encoded)},${DateTime.toDateUtc(now)})`;
				return result;
			}),
		);
	}));
