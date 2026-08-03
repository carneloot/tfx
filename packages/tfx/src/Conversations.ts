import * as Context from 'effect/Context';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';

import type * as Conversation from './Conversation.js';
import type * as ConversationBuilder from './ConversationBuilder.js';
import * as ConversationInput from './ConversationInput.js';
import {
	ConversationStorage,
	ConversationStorageError,
	type ConversationRow,
	type Mutation,
	type Scope,
	type TransitionResult,
} from './ConversationStorage.js';
import type * as Transition from './internal/conversation/Transition.js';
import type { TaggedError } from './TaggedError.js';
import { VersionedSchemaError } from './VersionedSchema.js';

export class ConversationScopeUnavailable extends Schema.TaggedErrorClass<ConversationScopeUnavailable>()(
	'ConversationScopeUnavailable',
	{ message: Schema.String },
) {}
export class HandledWithOutputFailure extends Schema.TaggedErrorClass<HandledWithOutputFailure>()(
	'HandledWithOutputFailure',
	{ cause: Schema.Unknown },
) {}
export class ConversationExecutionError extends Schema.TaggedErrorClass<ConversationExecutionError>()(
	'ConversationExecutionError',
	{ cause: Schema.Unknown },
) {}
export interface BuiltConversation<
	C extends Conversation.Conversation<any, any, any, any, any, any> =
		Conversation.Conversation<any, any, any, any, any, any>,
	R = never,
> {
	readonly declaration: C;
	readonly implementations: Readonly<
		Record<string, ConversationBuilder.StepHandlers<any, any, any, any>>
	>;
	readonly _requirements: R;
}
type BuiltRequirements<B> =
	B extends BuiltConversation<any, infer R> ? R : never;
type BuiltError<B> =
	B extends BuiltConversation<infer C, any> ? Conversation.ErrorOf<C> : never;
export type ConversationServiceError<B> =
	| BuiltError<B>
	| ConversationScopeUnavailable
	| ConversationStorageError
	| Schema.SchemaError
	| ConversationInput.ConversationInputDecodeError
	| VersionedSchemaError
	| HandledWithOutputFailure
	| ConversationExecutionError;
export interface ConversationsService {
	readonly start: <B extends BuiltConversation<any, any>>(
		built: B,
		input: Conversation.StartupOf<B['declaration']>,
		options: { readonly scope?: Scope; readonly conflict?: 'fail' | 'replace' },
	) => Effect.Effect<void, ConversationServiceError<B>, BuiltRequirements<B>>;
	readonly resume: <B extends BuiltConversation<any, any>>(
		built: B,
		input: unknown,
		options: {
			readonly scope?: Scope;
			readonly updateId: number;
			readonly row?: ConversationRow;
		},
	) => Effect.Effect<
		TransitionResult<void>,
		ConversationServiceError<B>,
		BuiltRequirements<B>
	>;
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
				new ConversationScopeUnavailable({
					message: 'Conversation requires bot, chat, and user scope',
				}),
			)
		: Effect.succeed(scope);
const output = <E extends TaggedError, R>(
	effect: Effect.Effect<void, E, R> | undefined,
) =>
	effect === undefined
		? Effect.void
		: Effect.mapError(
				effect,
				(cause) => new HandledWithOutputFailure({ cause }),
			);
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
			const start = <B extends BuiltConversation<any, any>>(
				built: B,
				input: Conversation.StartupOf<B['declaration']>,
				options: {
					readonly scope?: Scope;
					readonly conflict?: 'fail' | 'replace';
				},
			) =>
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
					return yield* Effect.gen(function* () {
						const now = yield* DateTime.now;
						const span = yield* Effect.currentSpan;
						yield* storage.create(
							{
								scope,
								originTrace: {
									traceId: span.traceId,
									spanId: span.spanId,
									sampled: span.sampled,
								},
								conversationId: built.declaration.id,
								version: built.declaration.version,
								step: initialStep,
								state,
								lastUpdateId: undefined,
								expiresAt:
									built.declaration.idleTimeout === undefined
										? undefined
										: DateTime.addDuration(now, built.declaration.idleTimeout),
							},
							options.conflict ?? 'fail',
						);
						yield* output(handlers.enter(state));
					}).pipe(Effect.withSpan('Conversation.start'));
				}) as Effect.Effect<
					void,
					ConversationServiceError<B>,
					BuiltRequirements<B>
				>;
			const resume = <B extends BuiltConversation<any, any>>(
				built: B,
				input: unknown,
				options: {
					readonly scope?: Scope;
					readonly updateId: number;
					readonly row?: ConversationRow;
				},
			) =>
				Effect.gen(function* () {
					return yield* Effect.gen(function* () {
						const scope = yield* requireScope(options.scope);
						const loaded = options.row ?? (yield* storage.load(scope));
						if (loaded === undefined) return { _tag: 'Missing' as const };
						const result = yield* storage
							.transition<
								void,
								ConversationServiceError<B>,
								BuiltRequirements<B>
							>(
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
													: yield* built.declaration.migrations
															.migrate(row.version, row.state)
															.pipe(
																Effect.mapError((cause) =>
																	cause instanceof VersionedSchemaError
																		? cause
																		: invariant(
																				'Invalid migrated state',
																				cause,
																			),
																),
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
										) as Effect.Effect<
											Transition.Transition<
												string,
												unknown,
												TaggedError,
												BuiltRequirements<B>
											>,
											ConversationServiceError<B>,
											BuiltRequirements<B>
										>;
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
										const now = yield* DateTime.now;
										return {
											value: undefined,
											mutation: {
												_tag: 'Persist' as const,
												step: target.step,
												state: normalizedState,
												version: built.declaration.version,
												...(built.declaration.idleTimeout === undefined
													? {}
													: {
															expiresAt: DateTime.addDuration(
																now,
																built.declaration.idleTimeout,
															),
														}),
												...(transition.afterCommit === undefined
													? {}
													: { afterCommit: transition.afterCommit }),
											},
										};
									}) as Effect.Effect<
										{ readonly value: void; readonly mutation: Mutation },
										ConversationServiceError<B>,
										BuiltRequirements<B>
									>,
								loaded.instanceId,
							)
							.pipe(Effect.withSpan('Conversation.transition'));
						if (result._tag === 'Applied') {
							if (result.afterCommit !== undefined)
								yield* output(result.afterCommit).pipe(
									Effect.withSpan('Conversation.afterCommit'),
								);
							if (result.row !== undefined) {
								const handlers = built.implementations[result.row.step];
								if (handlers === undefined)
									return yield* Effect.fail(
										invariant(`Missing handlers for step '${result.row.step}'`),
									);
								yield* output(handlers.enter(result.row.state)).pipe(
									Effect.withSpan('Conversation.enter'),
								);
							}
						}
						return result;
					}).pipe(Effect.withSpan('Conversation.resume'));
				}) as Effect.Effect<
					TransitionResult<void>,
					ConversationServiceError<B>,
					BuiltRequirements<B>
				>;
			const service: ConversationsService = {
				start,
				resume,
				cancelCurrent: (candidate) =>
					Effect.flatMap(requireScope(candidate), storage.cancel),
			};
			return service;
		}),
	);
