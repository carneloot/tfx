import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';

import * as Middleware from '../src/Middleware.js';

class CurrentUser extends Context.Service<
	CurrentUser,
	{ readonly id: number }
>()('test/CurrentUser') {}
class CurrentAdmin extends Context.Service<
	CurrentAdmin,
	{ readonly id: number }
>()('test/CurrentAdmin') {}
class UserRepository extends Context.Service<
	UserRepository,
	{ readonly find: () => number }
>()('test/UserRepository') {}

const RegisteredUser = Middleware.make('registered-user', {
	scope: 'global',
	provides: CurrentUser,
	error: Schema.Void,
});
const RequireAdmin = Middleware.make('require-admin', {
	scope: 'group',
	provides: CurrentAdmin,
	requires: [CurrentUser],
	error: Schema.Void,
});

describe('Middleware', () => {
	it('runs in scope order and exposes earlier request services', async () => {
		const order: Array<string> = [];
		const registeredLive = Middleware.implement(
			RegisteredUser,
			Effect.gen(function* () {
				const repository = yield* UserRepository;
				order.push('global');
				return { id: repository.find() };
			}),
		);
		const adminLive = Middleware.implement(
			RequireAdmin,
			Effect.gen(function* () {
				const user = yield* CurrentUser;
				order.push(`group:${user.id}`);
				return { id: user.id };
			}),
		);
		const program = Middleware.empty
			.use(registeredLive)
			.use(adminLive)
			.run(
				Effect.gen(function* () {
					const admin = yield* CurrentAdmin;
					order.push(`handler:${admin.id}`);
				}),
			);

		await Effect.runPromise(
			Effect.provideService(program, UserRepository, { find: () => 42 }),
		);
		expect(order).toEqual(['global', 'group:42', 'handler:42']);
	});

	it('merges captured infrastructure with request services across a registry chain', async () => {
		const registeredLive = Middleware.implement(
			RegisteredUser,
			Effect.map(UserRepository, (repository) => ({ id: repository.find() })),
		);
		const adminLive = Middleware.implement(
			RequireAdmin,
			Effect.map(CurrentUser, (user) => ({ id: user.id + 1 })),
		);
		const program = Effect.flatMap(Middleware.MiddlewareRegistry, (registry) =>
			registry.run(
				[RegisteredUser.id, RequireAdmin.id],
				Effect.map(CurrentAdmin, (admin) => admin.id),
			),
		) as Effect.Effect<number, never, Middleware.MiddlewareRegistry>;
		const withRegistry = Effect.provide(
			program,
			Middleware.layer(registeredLive, adminLive),
		);
		await expect(
			Effect.runPromise(
				Effect.provideService(withRegistry, UserRepository, { find: () => 42 }),
			),
		).resolves.toBe(43);
	});

	it('fails missing registry implementations inside the Effect channel', async () => {
		const registry = await Effect.runPromise(
			Effect.provide(Middleware.MiddlewareRegistry, Middleware.layer()),
		);
		expect(() => registry.run(['missing'], Effect.void)).not.toThrow();
		await expect(
			Effect.runPromise(Effect.flip(registry.run(['missing'], Effect.void))),
		).resolves.toMatchObject({
			_tag: 'MiddlewareRegistryError',
			middlewareId: 'missing',
		});
	});

	it('keeps pipelines immutable and rejects scope reversal', () => {
		const handler = Middleware.make('handler', {
			scope: 'handler',
			provides: CurrentUser,
			error: Schema.Void,
		});
		const global = Middleware.make('global', {
			scope: 'global',
			provides: CurrentAdmin,
			error: Schema.Void,
		});
		const first = Middleware.empty.use(
			Middleware.implement(handler, Effect.succeed({ id: 1 })),
		);
		expect(Middleware.empty.applications).toEqual([]);
		expect(() =>
			first.use(Middleware.implement(global, Effect.succeed({ id: 1 }))),
		).toThrow('cannot follow');
	});
});
