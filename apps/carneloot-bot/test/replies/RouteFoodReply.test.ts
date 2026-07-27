import * as PgClient from '@effect/sql-pg/PgClient';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';

import * as RouteFoodReply from '../../src/application/RouteFoodReply.js';
import {
	BotId,
	TelegramChatId,
	TelegramUserId,
	UserId,
} from '../../src/domain/Ids.js';

const botId = Schema.decodeUnknownSync(BotId)('bot-a');
const actorId = Schema.decodeUnknownSync(UserId)(
	'00000000-0000-4000-8000-000000000001',
);
const telegramUserId = Schema.decodeUnknownSync(TelegramUserId)(123);
const chatId = Schema.decodeUnknownSync(TelegramChatId)(456);
const input: RouteFoodReply.RouteFoodReplyInput = {
	actorId,
	botId,
	telegramUserId,
	chatId,
	updateId: 789,
	messageId: 10,
	messageDate: DateTime.makeUnsafe('2026-07-16T12:00:00Z'),
	repliedMessageId: 9,
	text: '50g',
};

const client = (stored: unknown, calls: string[]) => {
	const sql = ((parts: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
		const statement = parts.join('?');
		calls.push(`${statement}|${values.join('|')}`);
		return Effect.succeed(
			statement.startsWith('SELECT result_json')
				? [{ result_json: stored }]
				: [],
		);
	}) as unknown as PgClient.PgClient;
	Object.assign(sql, {
		withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
		json: (value: unknown) => value,
	});
	return Layer.succeed(PgClient.PgClient, sql);
};

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.runPromise(effect.pipe(Effect.provide(Layer.empty as Layer.Layer<R>)));

describe('RouteFoodReply ledger', () => {
	it('returns a strictly decoded persisted result after locking bot/update identity', async () => {
		const calls: string[] = [];
		const result = await run(
			RouteFoodReply.execute(input).pipe(
				Effect.provide(client({ _tag: 'Unrelated' }, calls)),
			),
		);
		expect(result).toEqual({ _tag: 'Unrelated' });
		expect(calls[0]).toContain('pg_advisory_xact_lock');
		expect(calls[0]).toContain('food-reply:bot-a:789');
		expect(calls[1]).toContain('WHERE bot_id=? AND update_id=?|bot-a|789');
	});

	it('rejects malformed persisted JSON instead of treating it as a route result', async () => {
		const error = await run(
			Effect.flip(
				RouteFoodReply.execute(input).pipe(
					Effect.provide(
						client({ _tag: 'FoodCorrected', entries: 'not-an-array' }, []),
					),
				),
			),
		);
		expect(error).toMatchObject({
			_tag: 'FoodReplyLedgerError',
			reason: 'InvalidStoredResult',
		});
	});
});
