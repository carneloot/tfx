import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import type * as Bot from './Bot.js';
import type * as BotGroup from './BotGroup.js';
import type * as Command from './Command.js';
import type * as CommandInput from './CommandInput.js';
import {
	HandlerRegistry,
	type AnyHandlerEntry,
	type CommandHandlerEntry,
	type MessageHandlerEntry,
} from './internal/bot/HandlerRegistry.js';
import { MessageContext } from './MessageContext.js';
import type * as MessageHandler from './MessageHandler.js';
import type * as MessageHandlerResult from './MessageHandlerResult.js';
import type * as MessageInput from './MessageInput.js';
import type * as Middleware from './Middleware.js';
import { UpdateContext } from './UpdateContext.js';
type GroupsOf<B> = B extends Bot.Bot<any, infer G> ? G : never;
type GroupAt<B, Id extends keyof GroupsOf<B>> =
	GroupsOf<B>[Id] extends BotGroup.BotGroup<any, any, any>
		? GroupsOf<B>[Id]
		: never;
type CommandsOf<G> = G extends BotGroup.BotGroup<any, infer C, any> ? C : never;
type MessagesOf<G> = G extends BotGroup.BotGroup<any, any, infer M> ? M : never;
type CommandAt<G, I extends keyof CommandsOf<G>> =
	CommandsOf<G>[I] extends Command.Command<any, any, any, any>
		? CommandsOf<G>[I]
		: never;
type MessageAt<G, I extends keyof MessagesOf<G>> =
	MessagesOf<G>[I] extends MessageHandler.MessageHandler<any, any, any, any>
		? MessagesOf<G>[I]
		: never;
type CDecoded<C> =
	C extends Command.Command<any, infer I, any, any>
		? CommandInput.Decoded<I>
		: never;
type MDecoded<H> =
	H extends MessageHandler.MessageHandler<any, infer I, any, any>
		? MessageInput.Decoded<I>
		: never;
type CError<C> = Command.Error<C>;
type MError<H> = MessageHandler.Error<H>;
type Provided<X> =
	X extends Command.Command<any, any, any, infer M>
		? Middleware.ProvidedBy<M>
		: X extends MessageHandler.MessageHandler<any, any, any, infer M>
			? Middleware.ProvidedBy<M>
			: never;
type Mwares<X> =
	X extends Command.Command<any, any, any, infer M>
		? M
		: X extends MessageHandler.MessageHandler<any, any, any, infer M>
			? M
			: never;
type MWErrors<X> =
	Mwares<X> extends infer M extends ReadonlyArray<Middleware.AnyMiddleware>
		? Middleware.DeclaredErrors<M>
		: never;
type InputReq<X> =
	X extends Command.Command<any, infer I, any, any>
		? CommandInput.Requirements<I>
		: X extends MessageHandler.MessageHandler<any, infer I, any, any>
			? MessageInput.Requirements<I>
			: never;
type HandlerReq<X, R> = Exclude<
	R,
	UpdateContext | MessageContext | Provided<X>
>;
type AllDecl<G> =
	| CommandsOf<G>[keyof CommandsOf<G>]
	| MessagesOf<G>[keyof MessagesOf<G>];
type GroupMiddlewareRequirement<G> = [
	AllDecl<G> extends infer X ? Mwares<X>[number] : never,
] extends [never]
	? never
	: Middleware.MiddlewareRegistry;
export interface Handlers<
	G extends BotGroup.BotGroup<any, any, any>,
	CR extends keyof CommandsOf<G>,
	MR extends keyof MessagesOf<G>,
	Requirements,
	Entries extends ReadonlyArray<AnyHandlerEntry> = readonly [],
> {
	readonly _remaining: CR;
	readonly _remainingMessages: MR;
	readonly _requirements: Requirements;
	readonly _entries: Entries;
	handle<const Id extends CR, A, E extends CError<CommandAt<G, Id>>, R>(
		id: Id,
		handler: (input: CDecoded<CommandAt<G, Id>>) => Effect.Effect<A, E, R>,
	): Handlers<
		G,
		Exclude<CR, Id>,
		MR,
		Requirements | HandlerReq<CommandAt<G, Id>, R> | InputReq<CommandAt<G, Id>>,
		readonly [
			...Entries,
			CommandHandlerEntry<
				CDecoded<CommandAt<G, Id>>,
				A,
				E,
				R,
				MWErrors<CommandAt<G, Id>>
			>,
		]
	>;
	handleMessage<const Id extends MR, E extends MError<MessageAt<G, Id>>, R>(
		id: Id,
		handler: (
			input: MDecoded<MessageAt<G, Id>>,
		) => Effect.Effect<MessageHandlerResult.MessageHandlerResult, E, R>,
	): Handlers<
		G,
		CR,
		Exclude<MR, Id>,
		Requirements | HandlerReq<MessageAt<G, Id>, R> | InputReq<MessageAt<G, Id>>,
		readonly [
			...Entries,
			MessageHandlerEntry<
				MDecoded<MessageAt<G, Id>>,
				E,
				R,
				MWErrors<MessageAt<G, Id>>
			>,
		]
	>;
}
export interface BuiltGroup<R = never> {
	readonly groupId: string;
	readonly entries: ReadonlyArray<AnyHandlerEntry>;
	readonly _requirements: R;
}
function makeHandlers(
	groupId: string,
	commands: any,
	messages: any,
	entries: ReadonlyArray<AnyHandlerEntry>,
): any {
	const addEntry = (
		tag: 'Command' | 'Message',
		id: string,
		handler: any,
		declaration: any,
	) => {
		if (
			entries.some(
				(e: any) =>
					e._tag === tag &&
					(tag === 'Command' ? e.commandId : e.messageHandlerId) === id,
			)
		)
			throw new Error(`Duplicate implementation '${id}' in group '${groupId}'`);
		const middlewareIds = Object.freeze(
			declaration.middleware.map((x: any) => x.id),
		);
		const entry: any = {
			_tag: tag,
			groupId,
			middlewareIds,
			handler,
			invoke: (registry: any, input: any) =>
				registry.run(middlewareIds, handler(input)),
			...(tag === 'Command' ? { commandId: id } : { messageHandlerId: id }),
		};
		return makeHandlers(groupId, commands, messages, [...entries, entry]);
	};
	return {
		_remaining: undefined,
		_remainingMessages: undefined,
		_requirements: undefined,
		_entries: entries,
		handle: (id: string, h: any) => addEntry('Command', id, h, commands[id]),
		handleMessage: (id: string, h: any) =>
			addEntry('Message', id, h, messages[id]),
	};
}
export const buildGroup = <
	B extends Bot.Bot<any, any>,
	Id extends keyof GroupsOf<B> & string,
	R,
>(
	bot: B,
	id: Id,
	implement: (
		h: Handlers<
			GroupAt<B, Id>,
			keyof CommandsOf<GroupAt<B, Id>>,
			keyof MessagesOf<GroupAt<B, Id>>,
			never
		>,
	) => Handlers<
		GroupAt<B, Id>,
		never,
		never,
		R,
		ReadonlyArray<AnyHandlerEntry>
	>,
): BuiltGroup<R> => {
	const d: any = bot.groups[id];
	const completed = implement(
		makeHandlers(d.id, d.commands, d.messageHandlers, []),
	);
	return Object.freeze({
		groupId: d.id,
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
		h: Handlers<
			GroupAt<B, Id>,
			keyof CommandsOf<GroupAt<B, Id>>,
			keyof MessagesOf<GroupAt<B, Id>>,
			never
		>,
	) => Handlers<
		GroupAt<B, Id>,
		never,
		never,
		R,
		ReadonlyArray<AnyHandlerEntry>
	>,
): Layer.Layer<
	HandlerRegistry,
	never,
	R | GroupMiddlewareRequirement<GroupAt<B, Id>>
> =>
	Layer.succeed(
		HandlerRegistry,
		buildGroup(bot, id, implement).entries,
	) as never;
