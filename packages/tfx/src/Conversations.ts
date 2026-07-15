import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';

import type * as Conversation from './Conversation.js';
import type * as ConversationBuilder from './ConversationBuilder.js';
import {
	ConversationStorage,
	type Scope,
	type TransitionResult,
} from './ConversationStorage.js';
import type * as Transition from './internal/conversation/Transition.js';
import { VersionedSchemaError } from './VersionedSchema.js';

export class ConversationScopeUnavailable extends Error {
	readonly _tag = 'ConversationScopeUnavailable';
}
export class HandledWithOutputFailure extends Error {
	readonly _tag = 'HandledWithOutputFailure';
	constructor(readonly cause: unknown) {
		super('Conversation state committed but output failed');
	}
}
export interface BuiltConversation<
	C extends Conversation.Conversation<any, any, any, any, any, any> =
		Conversation.Conversation<any, any, any, any, any, any>,
> {
	readonly declaration: C;
	readonly implementations: Readonly<
		Record<string, ConversationBuilder.StepHandlers<any, any, any, any>>
	>;
}
export interface ConversationsService {
	readonly start: <
		C extends Conversation.Conversation<any, any, any, any, any, any>,
	>(
		built: BuiltConversation<C>,
		input: Conversation.StartupOf<C>,
		options: { readonly scope?: Scope; readonly conflict?: 'fail' | 'replace' },
	) => Effect.Effect<void, unknown, unknown>;
	readonly resume: (
		built: BuiltConversation,
		input: unknown,
		options: { readonly scope?: Scope; readonly updateId: number },
	) => Effect.Effect<TransitionResult<void>, unknown, unknown>;
	readonly cancelCurrent: (
		scope?: Scope,
	) => Effect.Effect<boolean, ConversationScopeUnavailable>;
}
const requireScope = (
	scope?: Scope,
): Effect.Effect<Scope, ConversationScopeUnavailable> =>
	scope === undefined
		? Effect.fail(
				new ConversationScopeUnavailable(
					'Conversation requires bot, chat, and user scope',
				),
			)
		: Effect.succeed(scope);
const output = (effect: Effect.Effect<void, unknown, unknown> | undefined) =>
	effect === undefined
		? Effect.void
		: Effect.mapError(effect, (cause) => new HandledWithOutputFailure(cause));
export class Conversations extends Context.Service<
	Conversations,
	ConversationsService
>()('tfx/Conversations') {}
export const layer: Layer.Layer<Conversations, never, ConversationStorage> =
	Layer.effect(
		Conversations,
		Effect.map(ConversationStorage, (storage) => {
			const service: ConversationsService = {
				start: (built, input, options) =>
					Effect.gen(function* () {
						const scope = yield* requireScope(options.scope);
						const decoded = yield* Schema.decodeUnknownEffect(
							built.declaration.startup,
						)(input);
						const state = built.declaration.initialize(decoded);
						const now = yield* Effect.clockWith(
							(clock) => clock.currentTimeMillis,
						);
						yield* storage.create(
							{
								scope,
								conversationId: built.declaration.id,
								version: built.declaration.version,
								step: String(built.declaration.initialStep),
								state,
								lastUpdateId: undefined,
								expiresAt:
									built.declaration.idleTimeout === undefined
										? undefined
										: now + built.declaration.idleTimeout,
							},
							options.conflict ?? 'fail',
						);
						yield* output(
							built.implementations[
								String(built.declaration.initialStep)
							]!.enter(state),
						);
					}),
				resume: (built, input, options) =>
					Effect.gen(function* () {
						const scope = yield* requireScope(options.scope);
						const loaded = yield* storage.load(scope);
						if (loaded === undefined) return { _tag: 'Missing' as const };
						const result = yield* storage.transition<void, unknown, unknown>(
							scope,
							options.updateId,
							loaded.revision,
							(row) =>
								Effect.gen(function* () {
									const handlers = built.implementations[row.step]!;
									const state =
										row.version === built.declaration.version
											? row.state
											: built.declaration.migrations === undefined
												? yield* Effect.fail(
														new VersionedSchemaError(
															'MissingMigration',
															`Missing conversation migration ${row.version}→${built.declaration.version}`,
														),
													)
												: yield* built.declaration.migrations.migrate(
														row.version,
														row.state,
													);
									const transition = yield* handlers.onInput(
										state,
										input,
									) as Effect.Effect<Transition.Transition, unknown, unknown>;
									if (
										transition._tag === 'Complete' ||
										transition._tag === 'Cancelled'
									)
										return {
											value: undefined,
											mutation: {
												_tag: 'Delete' as const,
												...(transition.afterCommit === undefined
													? {}
													: { afterCommit: transition.afterCommit }),
											},
										};
									const target =
										transition._tag === 'Stay'
											? { step: row.step, state }
											: { step: transition.step, state: transition.state };
									yield* Schema.decodeUnknownEffect(
										built.declaration.steps[target.step]!.state,
									)(target.state);
									const now = yield* Effect.clockWith(
										(clock) => clock.currentTimeMillis,
									);
									return {
										value: undefined,
										mutation: {
											_tag: 'Persist' as const,
											...target,
											version: built.declaration.version,
											...(built.declaration.idleTimeout === undefined
												? {}
												: { expiresAt: now + built.declaration.idleTimeout }),
											...(transition.afterCommit === undefined
												? {}
												: { afterCommit: transition.afterCommit }),
										},
									};
								}),
						);
						if (result._tag === 'Applied') {
							if (result.row !== undefined)
								yield* output(
									built.implementations[result.row.step]!.enter(
										result.row.state,
									),
								);
							yield* output(result.afterCommit);
						}
						return result;
					}),
				cancelCurrent: (candidate) =>
					Effect.flatMap(requireScope(candidate), storage.cancel),
			};
			return service;
		}),
	);
