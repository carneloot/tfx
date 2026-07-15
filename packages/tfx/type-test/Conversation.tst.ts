import { Effect, Schema } from 'effect';
import {
	Conversation,
	ConversationBuilder,
	ConversationInput,
	Conversations,
	MessageContext,
} from 'tfx';

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
const noContextRequirement: ContextRequirements = undefined as never;
void noContextRequirement;
// @ts-expect-error text codecs must decode from string
ConversationInput.text(Schema.Number);
