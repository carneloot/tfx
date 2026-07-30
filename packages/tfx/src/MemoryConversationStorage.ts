import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Semaphore from 'effect/Semaphore';

import {
	ConversationStorage,
	ConversationStorageError,
	type ConversationRow,
	type ConversationStorageService,
	type Mutation,
} from './ConversationStorage.js';
import { key, type Scope } from './internal/conversation/Scope.js';

const withLock = <A, E, R>(
	lock: Effect.Effect<Semaphore.Semaphore>,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	Effect.flatMap(lock, (semaphore) => semaphore.withPermit(effect));

export const layer: Layer.Layer<ConversationStorage> = Layer.effect(
	ConversationStorage,
	Effect.gen(function* () {
		const rows = new Map<string, ConversationRow>();
		const locks = new Map<string, Semaphore.Semaphore>();
		const lockRegistry = yield* Semaphore.make(1);
		const mutex = (scope: Scope): Effect.Effect<Semaphore.Semaphore> =>
			lockRegistry.withPermit(
				Effect.gen(function* () {
					const k = key(scope);
					const existing = locks.get(k);
					if (existing !== undefined) return existing;
					const created = yield* Semaphore.make(1);
					locks.set(k, created);
					return created;
				}),
			);
		const service: ConversationStorageService = {
			load: (scope) =>
				withLock(
					mutex(scope),
					Effect.gen(function* () {
						const k = key(scope);
						const row = rows.get(k);
						if (row === undefined) return undefined;
						const now = yield* DateTime.now;
						if (
							row.expiresAt !== undefined &&
							DateTime.isLessThanOrEqualTo(row.expiresAt, now)
						) {
							rows.delete(k);
							return undefined;
						}
						return row;
					}),
				),
			create: (row, conflict) =>
				withLock(
					mutex(row.scope),
					Effect.gen(function* () {
						const k = key(row.scope);
						const existing = rows.get(k);
						const now = yield* DateTime.now;
						if (
							existing !== undefined &&
							existing.expiresAt !== undefined &&
							DateTime.isLessThanOrEqualTo(existing.expiresAt, now)
						)
							rows.delete(k);
						if (rows.has(k) && conflict === 'fail')
							return yield* Effect.fail(
								new ConversationStorageError(
									'Conflict',
									'Conversation already active',
								),
							);
						const created = Object.freeze({
							...row,
							instanceId: crypto.randomUUID(),
							revision: 0,
						});
						rows.set(k, created);
						return created;
					}),
				),
			transition: (scope, updateId, expectedRevision, handler) =>
				withLock(
					mutex(scope),
					Effect.gen(function* () {
						const k = key(scope);
						const current = rows.get(k);
						if (current === undefined) return { _tag: 'Missing' as const };
						if (current.lastUpdateId === updateId)
							return { _tag: 'Duplicate' as const, row: current };
						if (current.revision !== expectedRevision)
							return { _tag: 'Stale' as const, row: current };
						const now = yield* DateTime.now;
						if (
							current.expiresAt !== undefined &&
							DateTime.isLessThanOrEqualTo(current.expiresAt, now)
						) {
							rows.delete(k);
							return { _tag: 'Expired' as const };
						}
						const decision = yield* handler(current);
						let committed: ConversationRow | undefined;
						const mutation: Mutation = decision.mutation;
						if (mutation._tag === 'Delete') rows.delete(k);
						else {
							committed = Object.freeze({
								...current,
								step: mutation.step,
								state: mutation.state,
								version: mutation.version ?? current.version,
								revision: current.revision + 1,
								lastUpdateId: updateId,
								expiresAt: mutation.expiresAt,
							});
							rows.set(k, committed);
						}
						return {
							_tag: 'Applied' as const,
							value: decision.value,
							row: committed,
							...(mutation.afterCommit === undefined
								? {}
								: { afterCommit: mutation.afterCommit }),
						};
					}),
				),
			cancel: (scope) =>
				withLock(
					mutex(scope),
					Effect.sync(() => rows.delete(key(scope))),
				),
		};
		return service;
	}),
);
