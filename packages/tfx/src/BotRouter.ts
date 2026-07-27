import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';

import type * as Bot from './Bot.js';
import type * as BotBuilder from './BotBuilder.js';
import * as CallbackQueryContext from './CallbackQueryContext.js';
import * as Conversations from './Conversations.js';
import { ConversationStorage } from './ConversationStorage.js';
import * as DispatchOutcome from './DispatchOutcome.js';
import * as CommandParser from './internal/bot/CommandParser.js';
import type {
	AnyHandlerEntry,
	MessageHandlerEntry,
} from './internal/bot/HandlerRegistry.js';
import * as InternalRouter from './internal/runtime/Router.js';
import type { Update } from './internal/telegram/generated/TelegramApi.types.js';
import * as MessageContext from './MessageContext.js';
import * as MessageInput from './MessageInput.js';
import { MiddlewareRegistry } from './Middleware.js';
import { isRetryableError, type TaggedError } from './TaggedError.js';
import * as UpdateContext from './UpdateContext.js';
import * as UpdateRoutingScope from './UpdateRoutingScope.js';

export interface Router {
	readonly route: (
		update: Update,
	) => Effect.Effect<DispatchOutcome.DispatchOutcome, never>;
}
type RequirementsOfGroups<G extends ReadonlyArray<BotBuilder.BuiltGroup<any>>> =
	G[number] extends BotBuilder.BuiltGroup<infer R> ? R : never;
type BuiltConversation = Conversations.BuiltConversation<any, any>;
type RequirementsOfConversations<C extends ReadonlyArray<BuiltConversation>> =
	C[number] extends Conversations.BuiltConversation<any, infer R> ? R : never;
export type CancelEffect = (
	update: Update,
) => Effect.Effect<unknown, TaggedError, any>;
type RequirementsOfCancel<C> = C extends (
	update: Update,
) => Effect.Effect<unknown, TaggedError, infer R>
	? Exclude<R, UpdateContext.UpdateContext | MessageContext.MessageContext>
	: never;
export interface Options<
	B extends Bot.Bot<any, any>,
	G extends ReadonlyArray<BotBuilder.BuiltGroup<any>>,
	C extends ReadonlyArray<BuiltConversation> = readonly [],
	Cancel extends CancelEffect | undefined = undefined,
> {
	readonly bot: B;
	readonly groups: G;
	readonly conversations?: C;
	readonly botUsername: string;
	readonly cancel?: Cancel;
	readonly mapError?: (error: TaggedError) => DispatchOutcome.DispatchOutcome;
}
export class UnknownPersistedConversationError extends Data.TaggedError(
	'UnknownPersistedConversationError',
)<{ readonly conversationId: string }> {}

const record = (value: unknown): Readonly<Record<string, any>> | undefined =>
	typeof value === 'object' && value !== null
		? (value as Readonly<Record<string, any>>)
		: undefined;
const messageOf = (update: Update) => {
	const root = update as unknown as Readonly<Record<string, unknown>>;
	return (
		record(root.message) ??
		record(root.edited_message) ??
		record(root.business_message) ??
		record(root.edited_business_message)
	);
};
const rawConversationInput = (update: Update): unknown => {
	const root = update as unknown as Readonly<Record<string, any>>;
	if (root.callback_query !== undefined) return root.callback_query.data;
	if (root.message_reaction !== undefined)
		return root.message_reaction.new_reaction;
	return messageOf(update)?.text;
};
const outputFailure = (error: unknown) =>
	error instanceof Conversations.HandledWithOutputFailure
		? DispatchOutcome.handledWithOutputFailure('conversation-output-failed')
		: undefined;
const reasonOf = (error: TaggedError): string | undefined =>
	'reason' in error && typeof error.reason === 'string'
		? error.reason
		: undefined;
export const classifyFrameworkError = (
	error: TaggedError,
): DispatchOutcome.DispatchOutcome | undefined => {
	switch (error._tag) {
		case 'HandledWithOutputFailure':
			return DispatchOutcome.handledWithOutputFailure(
				'conversation-output-failed',
			);
		case 'ConversationScopeUnavailable':
		case 'ConversationRawInputError':
		case 'CallbackDataError':
		case 'ConversationChoiceError':
		case 'CommandInputError':
		case 'SchemaError':
			return DispatchOutcome.permanentInvalid('invalid-framework-input');
		case 'ConversationStorageError':
			return isRetryableError(error)
				? DispatchOutcome.retryableFailure('conversation-storage-unavailable')
				: reasonOf(error) === 'Conflict'
					? DispatchOutcome.permanentInvalid('conversation-conflict')
					: DispatchOutcome.fatal('conversation-storage-invariant');
		case 'VersionedSchemaError':
			return DispatchOutcome.fatal('conversation-version-invariant');
		case 'UnknownPersistedConversationError':
			return DispatchOutcome.fatal('unknown-persisted-conversation');
		case 'ConversationExecutionError':
			return DispatchOutcome.fatal('conversation-execution-invariant');
		default:
			return undefined;
	}
};
const safeIds = (update: Update): boolean => {
	const context = UpdateContext.make(update);
	return (
		Number.isSafeInteger(context.updateId) &&
		(context.userId === undefined || Number.isSafeInteger(context.userId)) &&
		(context.chatId === undefined || Number.isSafeInteger(context.chatId))
	);
};

/** Builds a declaration-driven router while capturing application services once. */
export const make = <
	B extends Bot.Bot<any, any>,
	const G extends ReadonlyArray<BotBuilder.BuiltGroup<any>>,
	const C extends ReadonlyArray<BuiltConversation> = readonly [],
	Cancel extends CancelEffect | undefined = undefined,
>(
	options: Options<B, G, C, Cancel>,
): Effect.Effect<
	Router,
	never,
	| RequirementsOfGroups<G>
	| RequirementsOfConversations<C>
	| RequirementsOfCancel<Cancel>
	| MiddlewareRegistry
	| ConversationStorage
	| Conversations.Conversations
> =>
	Effect.gen(function* () {
		type RuntimeRequirements =
			| RequirementsOfGroups<G>
			| RequirementsOfConversations<C>
			| RequirementsOfCancel<Cancel>
			| MiddlewareRegistry
			| ConversationStorage
			| Conversations.Conversations;
		const context = yield* Effect.context<RuntimeRequirements>();
		const middleware = yield* MiddlewareRegistry;
		const storage = yield* ConversationStorage;
		const conversations = yield* Conversations.Conversations;
		const entries = options.groups.flatMap((group) => group.entries);
		const messageEntries = (
			Object.values(options.bot.groups) as ReadonlyArray<any>
		)
			.flatMap((group) =>
				(Object.values(group.messageHandlers) as ReadonlyArray<any>).flatMap(
					(declaration) => {
						const entry = entries.find(
							(item) =>
								item._tag === 'Message' &&
								item.groupId === group.id &&
								item.messageHandlerId === declaration.id,
						);
						return entry === undefined ? [] : [entry];
					},
				),
			)
			.filter(
				(entry): entry is MessageHandlerEntry => entry._tag === 'Message',
			);
		const declarations = new Map<
			string,
			{ readonly groupId: string; readonly command: any }
		>();
		for (const group of Object.values(options.bot.groups) as ReadonlyArray<any>)
			for (const command of Object.values(group.commands) as ReadonlyArray<any>)
				for (const name of [command.name, ...command.aliases])
					declarations.set(name, { groupId: group.id, command });
		const mapError = (error: TaggedError) =>
			outputFailure(error) ??
			classifyFrameworkError(error) ??
			options.mapError?.(error) ??
			(isRetryableError(error)
				? DispatchOutcome.retryableFailure('retryable-router-error')
				: DispatchOutcome.fatal('unclassified-router-error'));
		const provideContexts = (
			update: Update,
			effect: Effect.Effect<any, any, any>,
		) => {
			let provided = Effect.provideService(
				effect,
				UpdateContext.UpdateContext,
				UpdateContext.make(update),
			);
			const message = messageOf(update);
			if (message !== undefined)
				provided = Effect.provideService(
					provided,
					MessageContext.MessageContext,
					MessageContext.make(message as never),
				);
			const callback = (update as any).callback_query;
			if (callback !== undefined)
				provided = Effect.provideService(
					provided,
					CallbackQueryContext.CallbackQueryContext,
					CallbackQueryContext.make(callback),
				);
			// Router's structural boundary is environment-free after capturing the
			// statically computed requirement union above.
			return Effect.provide(provided, context) as Effect.Effect<
				any,
				any,
				never
			>;
		};
		const router = InternalRouter.make({
			cancelBotUsername: options.botUsername,
			...(options.cancel === undefined
				? {}
				: {
						cancel: (update: Update) =>
							Effect.matchEffect(
								provideContexts(update, options.cancel!(update)),
								{
									onSuccess: () => Effect.succeed(DispatchOutcome.handled),
									onFailure: (error) => Effect.succeed(mapError(error)),
								},
							),
					}),
			conversation: (update) => {
				const routing = UpdateRoutingScope.fromUpdate(options.bot.name, update);
				const scope = UpdateRoutingScope.conversationScope(routing);
				if (scope === undefined || options.conversations === undefined)
					return Effect.succeed(undefined);
				return Effect.matchEffect(
					Effect.flatMap(storage.load(scope), (row) => {
						if (row === undefined) return Effect.succeed(undefined);
						const built = options.conversations!.find(
							(item) => item.declaration.id === row.conversationId,
						);
						if (built === undefined)
							return Effect.fail(
								new UnknownPersistedConversationError({
									conversationId: row.conversationId,
								}),
							);
						return Effect.map(
							provideContexts(
								update,
								conversations.resume(built, rawConversationInput(update), {
									scope,
									updateId: update.update_id,
								}),
							),
							() => DispatchOutcome.handled,
						);
					}),
					{
						onSuccess: (outcome) => Effect.succeed(outcome),
						onFailure: (error) => Effect.succeed(mapError(error)),
					},
				);
			},
			command: (update) => {
				const message = messageOf(update);
				if (message === undefined) return Effect.succeed(undefined);
				for (const [name, declaration] of declarations) {
					const source = CommandParser.matchCommand(
						message,
						name,
						options.botUsername,
					);
					if (source === undefined) continue;
					const entry: AnyHandlerEntry | undefined = entries.find(
						(item) =>
							item._tag === 'Command' &&
							item.groupId === declaration.groupId &&
							item.commandId === declaration.command.id,
					);
					if (entry === undefined)
						return Effect.succeed(
							DispatchOutcome.permanentInvalid('Unregistered command handler'),
						);
					return Effect.matchEffect(
						provideContexts(
							update,
							CommandParser.parse(declaration.command.input, source),
						),
						{
							onFailure: () =>
								Effect.succeed(
									DispatchOutcome.permanentInvalid('Invalid command input'),
								),
							onSuccess: (input) =>
								Effect.matchEffect(
									provideContexts(update, entry.invoke(middleware, input)),
									{
										onSuccess: () => Effect.succeed(DispatchOutcome.handled),
										onFailure: (error) => Effect.succeed(mapError(error)),
									},
								),
						},
					);
				}
				return Effect.succeed(undefined);
			},
			callback: () =>
				Effect.succeed(DispatchOutcome.permanentInvalid('Unhandled callback')),
			message: (update) => {
				const run = (
					index: number,
				): Effect.Effect<
					DispatchOutcome.DispatchOutcome | undefined,
					never
				> => {
					const entry = messageEntries[index];
					if (entry === undefined) return Effect.succeed(undefined);
					const group = (options.bot.groups as any)[entry.groupId];
					const declaration = group?.messageHandlers[entry.messageHandlerId];
					const decoded =
						declaration === undefined
							? undefined
							: MessageInput.decode(declaration.input, update);
					if (decoded === undefined) return run(index + 1);
					return Effect.matchEffect(provideContexts(update, decoded), {
						onFailure: () => run(index + 1),
						onSuccess: (input) =>
							Effect.matchEffect(
								provideContexts(update, entry.invoke(middleware, input)),
								{
									onFailure: (error) => Effect.succeed(mapError(error)),
									onSuccess: (result) =>
										result._tag === 'Handled'
											? Effect.succeed(DispatchOutcome.handled)
											: run(index + 1),
								},
							),
					});
				};
				return run(0);
			},
			fallback: () => Effect.succeed(DispatchOutcome.handled),
		});
		return Object.freeze({
			route: (update: Update) =>
				safeIds(update)
					? router.route(update)
					: Effect.succeed(
							DispatchOutcome.permanentInvalid('Unsafe Telegram identifier'),
						),
		});
	});
