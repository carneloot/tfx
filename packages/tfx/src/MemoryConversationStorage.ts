import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import {
	ConversationStorage,
	ConversationStorageError,
	type ConversationRow,
	type ConversationStorageService,
	type Mutation,
} from './ConversationStorage.js';
import { key, type Scope } from './internal/conversation/Scope.js';

class Mutex {
	private tail: Promise<void> = Promise.resolve();
	acquire(): Promise<() => void> {
		let release!: () => void;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		const previous = this.tail;
		this.tail = previous.then(() => next);
		return previous.then(() => release);
	}
}
const withLock = <A, E, R>(
	mutex: Mutex,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	Effect.acquireUseRelease(
		Effect.promise(() => mutex.acquire()),
		() => effect,
		(release) => Effect.sync(release),
	);

export const layer: Layer.Layer<ConversationStorage> = Layer.effect(
	ConversationStorage,
	Effect.sync(() => {
		const rows = new Map<string, ConversationRow>();
		const locks = new Map<string, Mutex>();
		const mutex = (scope: Scope) => {
			const k = key(scope);
			let value = locks.get(k);
			if (value === undefined) {
				value = new Mutex();
				locks.set(k, value);
			}
			return value;
		};
		const service: ConversationStorageService = {
			load: (scope) =>
				withLock(
					mutex(scope),
					Effect.sync(() => rows.get(key(scope))),
				),
			create: (row, conflict) =>
				withLock(
					mutex(row.scope),
					Effect.suspend(() => {
						const k = key(row.scope);
						if (rows.has(k) && conflict === 'fail')
							return Effect.fail(
								new ConversationStorageError(
									'Conflict',
									'Conversation already active',
								),
							);
						const created = Object.freeze({ ...row, revision: 0 });
						rows.set(k, created);
						return Effect.succeed(created);
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
						const now = yield* Clock.currentTimeMillis;
						if (current.expiresAt !== undefined && current.expiresAt <= now) {
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
