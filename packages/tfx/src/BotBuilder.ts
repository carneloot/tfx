import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import type * as Bot from './Bot.js';
import type * as BotGroup from './BotGroup.js';
import type * as Command from './Command.js';
import type * as CommandInput from './CommandInput.js';
import {
	HandlerRegistry,
	type AnyHandlerEntry,
	type HandlerEntry,
} from './internal/bot/HandlerRegistry.js';
import { MessageContext } from './MessageContext.js';
import type * as Middleware from './Middleware.js';
import { UpdateContext } from './UpdateContext.js';

type GroupsOf<B> = B extends Bot.Bot<any, infer Groups> ? Groups : never;
type GroupAt<B, Id extends keyof GroupsOf<B>> =
	GroupsOf<B>[Id] extends BotGroup.BotGroup<any, any> ? GroupsOf<B>[Id] : never;
type CommandsOf<G> =
	G extends BotGroup.BotGroup<any, infer Commands> ? Commands : never;
type CommandAt<G, Id extends keyof CommandsOf<G>> =
	CommandsOf<G>[Id] extends Command.Command<any, any, any, any>
		? CommandsOf<G>[Id]
		: never;
type Decoded<C> =
	C extends Command.Command<any, infer Input, any, any>
		? CommandInput.Decoded<Input>
		: never;
type InputRequirements<C> =
	C extends Command.Command<any, infer Input, any, any>
		? CommandInput.Requirements<Input>
		: never;
type DeclaredError<C> =
	C extends Command.Command<any, any, infer Error, any> ? Error : never;
type MiddlewareProvided<C> =
	C extends Command.Command<any, any, any, infer M>
		? Middleware.ProvidedBy<M>
		: never;
type MiddlewareErrors<C> =
	C extends Command.Command<any, any, any, infer M>
		? Middleware.DeclaredErrors<M>
		: never;
type HandlerRequirements<C, R> = Exclude<
	R,
	UpdateContext | MessageContext | MiddlewareProvided<C>
>;
type GroupMiddlewareRequirement<G> = [
	CommandsOf<G>[keyof CommandsOf<G>] extends infer C
		? C extends Command.Command<any, any, any, infer M>
			? M[number]
			: never
		: never,
] extends [never]
	? never
	: Middleware.MiddlewareRegistry;

export interface Handlers<
	G extends BotGroup.BotGroup<any, any>,
	Remaining extends keyof CommandsOf<G>,
	Requirements,
	Entries extends ReadonlyArray<AnyHandlerEntry> = readonly [],
> {
	/** Phantom state tracks implementations still required. */
	readonly _remaining: Remaining;
	readonly _requirements: Requirements;
	/** @internal */
	readonly _entries: Entries;
	handle<
		const Id extends Remaining,
		A,
		E extends DeclaredError<CommandAt<G, Id>>,
		R,
	>(
		id: Id,
		handler: (input: Decoded<CommandAt<G, Id>>) => Effect.Effect<A, E, R>,
	): Handlers<
		G,
		Exclude<Remaining, Id>,
		| Requirements
		| HandlerRequirements<CommandAt<G, Id>, R>
		| InputRequirements<CommandAt<G, Id>>,
		readonly [
			...Entries,
			HandlerEntry<
				Decoded<CommandAt<G, Id>>,
				A,
				E,
				R,
				MiddlewareErrors<CommandAt<G, Id>>
			>,
		]
	>;
}

const handlers = <
	G extends BotGroup.BotGroup<any, any>,
	Remaining extends keyof CommandsOf<G>,
	R,
	Entries extends ReadonlyArray<AnyHandlerEntry>,
>(
	groupId: string,
	commands: Readonly<Record<string, Command.Command<any, any, any, any>>>,
	entries: Entries,
): Handlers<G, Remaining, R, Entries> => ({
	_remaining: undefined as never,
	_requirements: undefined as never,
	_entries: entries,
	handle(id, handler) {
		if (entries.some((entry) => entry.commandId === id))
			throw new Error(
				`Duplicate implementation '${String(id)}' in group '${groupId}'`,
			);
		const middlewareIds = Object.freeze(
			commands[String(id)]!.middleware.map(
				(item: Middleware.AnyMiddleware) => item.id,
			),
		);
		return handlers(groupId, commands, [
			...entries,
			{
				groupId,
				commandId: String(id),
				middlewareIds,
				handler,
				invoke: (
					registry: Middleware.MiddlewareRegistryService,
					input: Decoded<CommandAt<G, typeof id>>,
				) =>
					registry.run<any, any, any>(
						middlewareIds,
						handler(input),
					) as Effect.Effect<
						Effect.Success<ReturnType<typeof handler>>,
						| Effect.Error<ReturnType<typeof handler>>
						| MiddlewareErrors<CommandAt<G, typeof id>>,
						Effect.Services<ReturnType<typeof handler>>
					>,
			},
		] as unknown as readonly [...Entries, AnyHandlerEntry]);
	},
});

export interface BuiltGroup<R = never> {
	readonly groupId: string;
	readonly entries: ReadonlyArray<AnyHandlerEntry>;
	readonly _requirements: R;
}

/** Build handlers as a composable value; BotRouter combines every group's entries. */
export const buildGroup = <
	B extends Bot.Bot<any, any>,
	Id extends keyof GroupsOf<B> & string,
	R,
>(
	bot: B,
	id: Id,
	implement: (
		handlers: Handlers<GroupAt<B, Id>, keyof CommandsOf<GroupAt<B, Id>>, never>,
	) => Handlers<GroupAt<B, Id>, never, R, ReadonlyArray<AnyHandlerEntry>>,
): BuiltGroup<R> => {
	const declaration = bot.groups[id] as GroupAt<B, Id>;
	const completed = implement(
		handlers(String(declaration.id), declaration.commands, []),
	);
	return Object.freeze({
		groupId: String(declaration.id),
		entries: Object.freeze([...completed._entries]),
		_requirements: undefined as R,
	});
};

export const group = <
	B extends Bot.Bot<any, any>,
	Id extends keyof GroupsOf<B> & string,
	R,
>(
	bot: B,
	id: Id,
	implement: (
		handlers: Handlers<GroupAt<B, Id>, keyof CommandsOf<GroupAt<B, Id>>, never>,
	) => Handlers<GroupAt<B, Id>, never, R, ReadonlyArray<AnyHandlerEntry>>,
): Layer.Layer<
	HandlerRegistry,
	never,
	R | GroupMiddlewareRequirement<GroupAt<B, Id>>
> => {
	const built = buildGroup(bot, id, implement);
	return Layer.succeed(HandlerRegistry, built.entries) as Layer.Layer<
		HandlerRegistry,
		never,
		R | GroupMiddlewareRequirement<GroupAt<B, Id>>
	>;
};
