import * as PgClient from '@effect/sql-pg/PgClient';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import * as TfxPostgres from '@tfx/postgres/TfxPostgres';
import { Deferred, Effect, Fiber, Layer, Redacted, Ref } from 'effect';
import {
	Bot,
	BotBuilder,
	BotGroup,
	BotRouter,
	Command,
	Conversations,
	DispatchOutcome,
	MemoryConversationStorage,
	MemoryUpdateDeduplicator,
	Middleware,
	UpdateContext,
} from 'tfx';
import { BotRuntime } from 'tfx/BotRuntime';
import * as BotRuntimeLive from 'tfx/BotRuntime';
import * as UpdateDelivery from 'tfx/UpdateDelivery';
import { describe, expect, it } from 'vitest';

const enabled =
	process.env.TEST_DATABASE_URL !== undefined ||
	process.env.RUN_TESTCONTAINERS === 'true';
if (process.env.CI === 'true' && !enabled)
	throw new Error('CI must run concurrency E2E with PostgreSQL');
const postgres: Layer.Layer<PgClient.PgClient, unknown, never> =
	process.env.TEST_DATABASE_URL === undefined
		? Layer.unwrap(
				Effect.map(
					Effect.acquireRelease(
						Effect.promise(() =>
							new PostgreSqlContainer('postgres:17-alpine').start(),
						),
						(container) =>
							Effect.promise(() => container.stop()).pipe(Effect.asVoid),
					),
					(container) =>
						PgClient.layer({
							url: Redacted.make(container.getConnectionUri()),
						}),
				),
			)
		: PgClient.layer({ url: Redacted.make(process.env.TEST_DATABASE_URL) });
const group = BotGroup.make('work').add(Command.make('run', { name: 'run' }));
const declaration = Bot.make('concurrency').add(group);
const update = (id: number, chatId: number, userId = 100) => ({
	update_id: id,
	message: {
		message_id: id,
		date: 0,
		chat: { id: chatId, type: 'private' },
		from: { id: userId, is_bot: false, first_name: 'A' },
		text: '/run',
		entities: [{ type: 'bot_command', offset: 0, length: 4 }],
	},
});
const routerInfrastructure = Layer.mergeAll(
	Middleware.layer(),
	MemoryConversationStorage.layer,
	Layer.provide(Conversations.layer, MemoryConversationStorage.layer),
);
const makeRouter = (handler: Effect.Effect<void, never, never>) => {
	const built = BotBuilder.buildGroup(declaration, 'work', (handlers) =>
		handlers.handle('run', () => handler),
	);
	return Effect.provide(
		BotRouter.make({
			bot: declaration,
			groups: [built],
			botUsername: 'concurrency_bot',
		}),
		routerInfrastructure,
	) as Effect.Effect<BotRouter.Router, never, never>;
};
const runtimeLayer = (router: BotRouter.Router, pg = postgres) =>
	Layer.provide(
		BotRuntimeLive.layer(declaration, {
			delivery: UpdateDelivery.manual,
			router,
			concurrency: 4,
			capacity: 8,
			leaseDuration: 300,
			heartbeatInterval: 100,
			waitTimeout: 300,
			retention: 10_000,
		}),
		Layer.provide(
			TfxPostgres.layer({
				schema: 'tfx_concurrency_e2e',
				tablePrefix: 'case_',
			}),
			pg,
		),
	);
const runInScope = (layer: Layer.Layer<BotRuntime, unknown>, value: unknown) =>
	Effect.scoped(
		Effect.gen(function* () {
			const context = yield* Layer.build(layer);
			return yield* Effect.provide(
				Effect.flatMap(BotRuntime, (runtime) =>
					runtime.dispatch(value as never),
				),
				context,
			);
		}),
	);

if (!enabled)
	describe.skip('concurrency E2E', () => {
		it('requires PostgreSQL', () => {});
	});
else
	describe.sequential('concurrency E2E', () => {
		it('deduplicates one update across independently scoped replica runtimes', async () => {
			await Effect.runPromise(
				Effect.provide(
					Effect.gen(function* () {
						const sql = yield* PgClient.PgClient;
						yield* sql.unsafe(
							'DROP SCHEMA IF EXISTS tfx_concurrency_e2e CASCADE',
						);
					}),
					postgres,
				),
			);
			const count = Ref.makeUnsafe(0);
			const entered = Deferred.makeUnsafe<void>();
			const release = Deferred.makeUnsafe<void>();
			const router = await Effect.runPromise(
				makeRouter(
					Effect.andThen(
						Effect.andThen(
							Ref.update(count, (n) => n + 1),
							Deferred.succeed(entered, undefined),
						),
						Deferred.await(release),
					),
				),
			);
			const first = Effect.runFork(
				runInScope(runtimeLayer(router), update(1, 10)) as Effect.Effect<
					DispatchOutcome.DispatchOutcome,
					unknown,
					never
				>,
			);
			await Effect.runPromise(Deferred.await(entered));
			const second = Effect.runFork(
				runInScope(runtimeLayer(router), update(1, 10)) as Effect.Effect<
					DispatchOutcome.DispatchOutcome,
					unknown,
					never
				>,
			);
			await Effect.runPromise(Deferred.succeed(release, undefined));
			expect(await Effect.runPromise(Fiber.join(first))).toEqual(
				DispatchOutcome.handled,
			);
			expect(await Effect.runPromise(Fiber.join(second))).toEqual(
				DispatchOutcome.handled,
			);
			expect(Ref.getUnsafe(count)).toBe(1);
		});

		it('keeps same-chat FIFO while unrelated chats overlap and rejects unsafe IDs', async () => {
			const enteredFirst = Deferred.makeUnsafe<void>();
			const releaseFirst = Deferred.makeUnsafe<void>();
			const enteredOther = Deferred.makeUnsafe<void>();
			const order: number[] = [];
			const handlers = BotBuilder.buildGroup(declaration, 'work', (builder) =>
				builder.handle('run', () =>
					Effect.gen(function* () {
						const context = yield* UpdateContext.UpdateContext;
						order.push(context.updateId);
						if (context.updateId === 10) {
							yield* Deferred.succeed(enteredFirst, undefined);
							yield* Deferred.await(releaseFirst);
						}
						if (context.updateId === 12)
							yield* Deferred.succeed(enteredOther, undefined);
					}),
				),
			);
			const router = await Effect.runPromise(
				Effect.provide(
					BotRouter.make({
						bot: declaration,
						groups: [handlers],
						botUsername: 'concurrency_bot',
					}),
					routerInfrastructure,
				) as Effect.Effect<BotRouter.Router, never, never>,
			);
			const layer = Layer.provide(
				BotRuntimeLive.layer(declaration, {
					delivery: UpdateDelivery.manual,
					router,
					concurrency: 2,
					capacity: 4,
				}),
				MemoryUpdateDeduplicator.layerMemory,
			);
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const context = yield* Layer.build(layer);
						const service = yield* Effect.provide(BotRuntime, context);
						const first = yield* Effect.forkChild(
							service.dispatch(update(10, 20) as never),
						);
						yield* Deferred.await(enteredFirst);
						const same = yield* Effect.forkChild(
							service.dispatch(update(11, 20) as never),
						);
						const other = yield* Effect.forkChild(
							service.dispatch(update(12, 21) as never),
						);
						yield* Deferred.await(enteredOther);
						expect(order).toEqual([10, 12]);
						yield* Deferred.succeed(releaseFirst, undefined);
						yield* Fiber.join(first);
						yield* Fiber.join(same);
						yield* Fiber.join(other);
						expect(order).toEqual([10, 12, 11]);
						expect(
							yield* service.dispatch(
								update(Number.MAX_SAFE_INTEGER + 1, 20) as never,
							),
						).toMatchObject({ _tag: 'PermanentInvalid' });
						expect(
							yield* service.dispatch(
								update(13, Number.MAX_SAFE_INTEGER + 1) as never,
							),
						).toMatchObject({ _tag: 'PermanentInvalid' });
						expect(
							yield* service.dispatch(
								update(14, 20, Number.MAX_SAFE_INTEGER + 1) as never,
							),
						).toMatchObject({ _tag: 'PermanentInvalid' });
						expect(order).toEqual([10, 12, 11]);
					}),
				) as Effect.Effect<void, unknown, never>,
			);
		});
	});

/* Polling contiguous-offset retry/skip behavior is exercised through the public
Polling delivery facade in packages/tfx/test/Polling.test.ts; this suite adds the
cross-replica durable claim and public BotRouter partitioning integration proof. */
