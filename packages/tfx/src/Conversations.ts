import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';

import type * as Conversation from './Conversation.js';
import type * as ConversationBuilder from './ConversationBuilder.js';
import * as ConversationInput from './ConversationInput.js';
import {
	ConversationStorage,
	ConversationStorageError,
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
	) => Effect.Effect<
		boolean,
		ConversationScopeUnavailable | ConversationStorageError
	>;
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
const invariant = (message: string, cause?: unknown) =>
	new ConversationStorageError(
		'InvariantViolation',
		cause === undefined ? message : `${message}: ${String(cause)}`,
	);
const decodeState = (
	schema: Schema.Schema<any>,
	value: unknown,
	label: string,
) =>
	Schema.decodeUnknownEffect(schema)(value).pipe(
		Effect.mapError((cause) => invariant(`Invalid ${label}`, cause)),
	);
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
						const initialized = built.declaration.initialize(decoded);
						const initialStep = String(built.declaration.initialStep);
						const initial = built.declaration.steps[initialStep];
						if (initial === undefined)
							return yield* Effect.fail(
								invariant(`Unknown initial step '${initialStep}'`),
							);
						const state = yield* decodeState(
							initial.state,
							initialized,
							`initial state for step '${initialStep}'`,
						);
						const handlers = built.implementations[initialStep];
						if (handlers === undefined)
							return yield* Effect.fail(
								invariant(`Missing handlers for step '${initialStep}'`),
							);
						const now = yield* Effect.clockWith(
							(clock) => clock.currentTimeMillis,
						);
						yield* storage.create(
							{
								scope,
								conversationId: built.declaration.id,
								version: built.declaration.version,
								step: initialStep,
								state,
								lastUpdateId: undefined,
								expiresAt:
									built.declaration.idleTimeout === undefined
										? undefined
										: now + built.declaration.idleTimeout,
							},
							options.conflict ?? 'fail',
						);
						yield* output(handlers.enter(state));
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
									if (row.conversationId !== built.declaration.id)
										return yield* Effect.fail(
											invariant(
												`Stored conversation '${row.conversationId}' does not match '${built.declaration.id}'`,
											),
										);
									const step = built.declaration.steps[row.step];
									const handlers = built.implementations[row.step];
									if (step === undefined || handlers === undefined)
										return yield* Effect.fail(
											invariant(`Unknown stored step '${row.step}'`),
										);
									const migrated =
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
									const state = yield* decodeState(
										step.state,
										migrated,
										`stored state for step '${row.step}'`,
									);
									const decoded = yield* Effect.result(
										ConversationInput.decode(step.input, input),
									);
									const transition = yield* (
										decoded._tag === 'Success'
											? handlers.onInput(state, decoded.success)
											: handlers.onInvalid === undefined
												? Effect.fail(decoded.failure)
												: handlers.onInvalid(state, decoded.failure)
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
									const targetDeclaration =
										built.declaration.steps[target.step];
									if (targetDeclaration === undefined)
										return yield* Effect.fail(
											invariant(`Unknown target step '${target.step}'`),
										);
									const normalizedState = yield* decodeState(
										targetDeclaration.state,
										target.state,
										`target state for step '${target.step}'`,
									);
									const now = yield* Effect.clockWith(
										(clock) => clock.currentTimeMillis,
									);
									return {
										value: undefined,
										mutation: {
											_tag: 'Persist' as const,
											step: target.step,
											state: normalizedState,
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
							yield* output(result.afterCommit);
							if (result.row !== undefined) {
								const handlers = built.implementations[result.row.step];
								if (handlers === undefined)
									return yield* Effect.fail(
										invariant(`Missing handlers for step '${result.row.step}'`),
									);
								yield* output(handlers.enter(result.row.state));
							}
						}
						return result;
					}),
				cancelCurrent: (candidate) =>
					Effect.flatMap(requireScope(candidate), storage.cancel),
			};
			return service;
		}),
	);
