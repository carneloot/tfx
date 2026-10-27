import { Context, Effect, Schema } from 'effect';
import {
	Conversation,
	ConversationBuilder,
	ConversationInput,
	Conversations,
	MessageContext,
	Middleware,
	UpdateContext,
} from 'tfx';
import { expectTypeOf } from 'vitest';

const flow = Conversation.make('flow', {
	version: 1,
	startup: Schema.Struct({ count: Schema.Number }),
	initialStep: 'first',
	initialize: (input) => ({ count: input.count }),
	steps: {
		first: Conversation.step('first', {
			state: Schema.Struct({ count: Schema.Number }),
			input: ConversationInput.text(Schema.String),
		}),
		second: Conversation.step('second', {
			state: Schema.Struct({ name: Schema.String }),
			input: ConversationInput.text(Schema.String),
		}),
	},
	error: Schema.Void,
});
const partial = ConversationBuilder.make(flow).step('first', {
	enter: () => Effect.void,
	onInput: (_state, name) =>
		Effect.succeed(ConversationBuilder.to('second', { name })),
});
// @ts-expect-error exhaustive implementation requires second step
ConversationBuilder.done(partial);
const built = ConversationBuilder.done(
	partial.step('second', {
		enter: () => Effect.void,
		onInput: () => Effect.succeed(ConversationBuilder.complete()),
	}),
);
// @ts-expect-error unknown step
ConversationBuilder.make(flow).step('missing', {
	enter: () => Effect.void,
	onInput: () => Effect.succeed(ConversationBuilder.complete()),
});
ConversationBuilder.make(flow).step('first', {
	enter: () => Effect.void,
	// @ts-expect-error target state must match second step
	onInput: () => Effect.succeed(ConversationBuilder.to('second', { count: 1 })),
});
ConversationBuilder.make(flow).step('first', {
	enter: () => Effect.void,
	// @ts-expect-error transitions must target a declared step
	onInput: () => Effect.succeed(ConversationBuilder.to('missing', {})),
});
ConversationBuilder.make(flow).step('first', {
	enter: () => Effect.void,
	// @ts-expect-error handlers must use the declaration's error channel
	onInput: () => Effect.fail({ _tag: 'Undeclared' as const }),
});
ConversationBuilder.make(flow).step('first', {
	enter: () => Effect.void,
	// @ts-expect-error post-commit output must use the declaration's error channel
	onInput: () =>
		Effect.succeed(
			ConversationBuilder.complete({
				afterCommit: Effect.fail({ _tag: 'Undeclared' as const }),
			}),
		),
});
declare const invalidHandlers: {
	readonly enter: () => Effect.Effect<void>;
	readonly onInput: () => Effect.Effect<
		ReturnType<typeof ConversationBuilder.complete<never, never>>
	>;
	readonly onInvalid?: () => Effect.Effect<
		ReturnType<typeof ConversationBuilder.to<'second', { count: number }>>
	>;
};
// @ts-expect-error optional invalid handlers must also return a valid transition
ConversationBuilder.make(flow).step('first', invalidHandlers);
declare const conversations: Conversations.ConversationsService;
conversations.start(
	built,
	{ count: 1 },
	{ scope: { botId: 'b', chatId: 1, userId: 1 } },
);
conversations.start(
	built,
	// @ts-expect-error startup input is schema-derived
	{ count: 'one' },
	{ scope: { botId: 'b', chatId: 1, userId: 1 } },
);
const contextBuilder = ConversationBuilder.make(flow).step('first', {
	enter: () => Effect.void,
	onInput: () =>
		Effect.as(MessageContext.MessageContext, ConversationBuilder.complete()),
});
type ContextRequirements = (typeof contextBuilder)['_requirements'];
expectTypeOf<ContextRequirements>().toEqualTypeOf<never>();
// @ts-expect-error text codecs must decode from string
ConversationInput.text(Schema.Number);

class EnterService extends Context.Service<
	EnterService,
	{ readonly enter: true }
>()('EnterService') {}
class InputService extends Context.Service<
	InputService,
	{ readonly input: true }
>()('InputService') {}
class InvalidService extends Context.Service<
	InvalidService,
	{ readonly invalid: true }
>()('InvalidService') {}
class OutputService extends Context.Service<
	OutputService,
	{ readonly output: true }
>()('OutputService') {}
class InvalidOutputService extends Context.Service<
	InvalidOutputService,
	{ readonly invalidOutput: true }
>()('InvalidOutputService') {}
class CurrentUser extends Context.Service<
	CurrentUser,
	{ readonly user: true }
>()('CurrentUser') {}
const registered = Middleware.make('registered', {
	scope: 'global',
	provides: CurrentUser,
	error: Schema.Void,
});
const dependencyFlow = Conversation.make('dependencies', {
	version: 1,
	startup: Schema.Void,
	initialStep: 'input',
	initialize: () => undefined,
	steps: {
		input: Conversation.step('input', {
			state: Schema.Void,
			input: ConversationInput.text(Schema.String),
		}),
	},
	middleware: [registered],
	error: Schema.Void,
});
const dependencyBuilder = ConversationBuilder.make(dependencyFlow).step(
	'input',
	{
		enter: () => Effect.asVoid(EnterService),
		onInput: () =>
			Effect.gen(function* () {
				yield* InputService;
				yield* CurrentUser;
				yield* UpdateContext.UpdateContext;
				return ConversationBuilder.complete({
					afterCommit: Effect.gen(function* () {
						yield* OutputService;
						yield* MessageContext.MessageContext;
					}),
				});
			}),
		onInvalid: () =>
			Effect.as(
				InvalidService,
				ConversationBuilder.stay({
					afterCommit: Effect.asVoid(InvalidOutputService),
				}),
			),
	},
);
expectTypeOf<(typeof dependencyBuilder)['_requirements']>().toEqualTypeOf<
	| EnterService
	| InputService
	| InvalidService
	| OutputService
	| InvalidOutputService
>();
const outputOnlyBuilder = ConversationBuilder.make(dependencyFlow).step(
	'input',
	{
		enter: () => Effect.void,
		onInput: () =>
			Effect.succeed(
				ConversationBuilder.complete({
					afterCommit: Effect.asVoid(OutputService),
				}),
			),
	},
);
expectTypeOf<
	(typeof outputOnlyBuilder)['_requirements']
>().toEqualTypeOf<OutputService>();
const outputOnly = ConversationBuilder.done(outputOnlyBuilder);
expectTypeOf<
	Effect.Services<ReturnType<typeof conversations.start<typeof outputOnly>>>
>().toEqualTypeOf<OutputService>();
declare const optionalHandlers: {
	readonly enter: () => Effect.Effect<void>;
	readonly onInput: () => Effect.Effect<
		ReturnType<typeof ConversationBuilder.complete<never, never>>
	>;
	readonly onInvalid?: () => Effect.Effect<
		ReturnType<typeof ConversationBuilder.stay<never, OutputService>>,
		never,
		InvalidService
	>;
};
const optionalBuilder = ConversationBuilder.make(dependencyFlow).step(
	'input',
	optionalHandlers,
);
expectTypeOf<(typeof optionalBuilder)['_requirements']>().toEqualTypeOf<
	InvalidService | OutputService
>();
