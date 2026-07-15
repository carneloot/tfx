import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { Bot, BotBuilder, BotGroup, Command, Middleware } from 'tfx';
import { describe, expect, it } from 'vitest';

import { HandlerRegistry } from '../src/internal/bot/HandlerRegistry.js';

class CurrentUser extends Context.Service<
	CurrentUser,
	{ readonly id: number }
>()('test/BotCurrentUser') {}

describe('Bot declarations', () => {
	it('are immutable and add returns a new declaration', () => {
		const empty = BotGroup.make('pets');
		const pets = empty.add(
			Command.make('add', { name: 'add_pet', error: Schema.Void }),
		);
		expect(Object.isFrozen(empty)).toBe(true);
		expect(Object.isFrozen(pets.commands)).toBe(true);
		expect(Object.keys(empty.commands)).toEqual([]);
		expect(Object.keys(pets.commands)).toEqual(['add']);
		expect('updateKinds' in pets.commands.add!).toBe(false);
	});

	it('rejects invalid Telegram command names with fragment context', () => {
		const fragment = BotGroup.make('pets').add(
			Command.make('add', { name: 'Add-Pet', error: Schema.Void }),
		);
		expect(() => Bot.make('App').add(fragment)).toThrow("fragment 'pets'");
	});

	it('rejects command-name collisions across fragments', () => {
		const pets = BotGroup.make('pets').add(
			Command.make('add', { name: 'shared', error: Schema.Void }),
		);
		const food = BotGroup.make('food').add(
			Command.make('add', { name: 'shared', error: Schema.Void }),
		);
		expect(() => Bot.make('App').add(pets).add(food)).toThrow(
			"fragments 'pets' and 'food'",
		);
	});

	it('derives Telegram menu commands from declaration metadata', () => {
		const bot = Bot.make('App').add(
			BotGroup.make('pets')
				.add(
					Command.make('add', {
						name: 'add_pet',
						description: 'Add a pet',
						error: Schema.Void,
					}),
				)
				.add(
					Command.make('list', {
						name: 'list_pets',
						description: 'List pets',
						error: Schema.Void,
					}),
				),
		);
		expect(Bot.commandMenu(bot)).toEqual([
			{ command: 'add_pet', description: 'Add a pet' },
			{ command: 'list_pets', description: 'List pets' },
		]);
	});

	it.each([undefined, '', 'x'.repeat(257)])(
		'rejects invalid menu description %j',
		(description) => {
			const bot = Bot.make('App').add(
				BotGroup.make('pets').add(
					Command.make('add', {
						name: 'add_pet',
						...(description === undefined ? {} : { description }),
						error: Schema.Void,
					}),
				),
			);
			expect(() => Bot.commandMenu(bot)).toThrow(
				"Command 'add_pet' in fragment 'pets' must have a description between 1 and 256 characters",
			);
		},
	);

	it('stores middleware ids and exposes a registry-backed invocation bridge', async () => {
		const declaration = Middleware.make('current-user', {
			scope: 'command',
			provides: CurrentUser,
			error: Schema.Void,
		});
		const application = Middleware.implement(
			declaration,
			Effect.succeed({ id: 42 }),
		);
		const group = BotGroup.make('users').add(
			Command.make('show', {
				name: 'show',
				middleware: [declaration],
				error: Schema.Void,
			}),
		);
		const bot = Bot.make('App').add(group);
		const handlers = BotBuilder.group(bot, 'users', (builder) =>
			builder.handle('show', () => Effect.map(CurrentUser, (user) => user.id)),
		);
		const program = Effect.gen(function* () {
			const registry = yield* Middleware.MiddlewareRegistry;
			const [entry] = yield* HandlerRegistry;
			expect(entry!.middlewareIds).toEqual(['current-user']);
			return yield* entry!.invoke(registry, {});
		}) as Effect.Effect<
			number,
			unknown,
			Middleware.MiddlewareRegistry | HandlerRegistry
		>;
		const runnable = Effect.provide(
			Effect.provide(program, handlers),
			Middleware.layer(application),
		);
		await expect(Effect.runPromise(runnable)).resolves.toBe(42);
	});

	it('rejects runtime-composed duplicate group ids', () => {
		const first = BotGroup.make('pets');
		const second = BotGroup.make('pets');
		expect(() =>
			Bot.make('App')
				.add(first)
				.add(second as never),
		).toThrow("Duplicate group id 'pets'");
	});
});
