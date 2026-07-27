import type * as Command from './Command.js';
import type * as MessageHandler from './MessageHandler.js';

type Commands = Readonly<Record<string, Command.Command<any, any, any, any>>>;
type Messages = Readonly<
	Record<string, MessageHandler.MessageHandler<any, any, any, any>>
>;
export interface BotGroup<
	Id extends string,
	C extends Commands,
	M extends Messages = {},
> {
	readonly _tag: 'BotGroup';
	readonly id: Id;
	readonly commands: C;
	readonly messageHandlers: M;
	add<X extends Command.Command<any, any, any, any>>(
		command: X & (X['id'] extends keyof C ? never : unknown),
	): BotGroup<Id, C & { readonly [K in X['id']]: X }, M>;
	addMessage<X extends MessageHandler.MessageHandler<any, any, any, any>>(
		handler: X & (X['id'] extends keyof M ? never : unknown),
	): BotGroup<Id, C, M & { readonly [K in X['id']]: X }>;
}
const build = <Id extends string, C extends Commands, M extends Messages>(
	id: Id,
	commands: C,
	messageHandlers: M,
): BotGroup<Id, C, M> =>
	Object.freeze({
		_tag: 'BotGroup' as const,
		id,
		commands: Object.freeze(commands),
		messageHandlers: Object.freeze(messageHandlers),
		add<X extends Command.Command<any, any, any, any>>(command: X) {
			if (Object.hasOwn(commands, command.id))
				throw new Error(
					`Duplicate command id '${command.id}' in group '${id}'`,
				);
			return build(
				id,
				{ ...commands, [command.id]: command } as C & {
					readonly [K in X['id']]: X;
				},
				messageHandlers,
			);
		},
		addMessage<X extends MessageHandler.MessageHandler<any, any, any, any>>(
			handler: X,
		) {
			if (Object.hasOwn(messageHandlers, handler.id))
				throw new Error(
					`Duplicate message handler id '${handler.id}' in group '${id}'`,
				);
			return build(id, commands, {
				...messageHandlers,
				[handler.id]: handler,
			} as M & { readonly [K in X['id']]: X });
		},
	});
export const make = <const Id extends string>(id: Id): BotGroup<Id, {}, {}> =>
	build(id, {}, {});
