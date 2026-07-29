import { Context, Effect, Schema } from 'effect';
import {
	Bot,
	BotBuilder,
	BotGroup,
	BotRouter,
	Command,
	Conversation,
	ConversationBuilder,
	ConversationInput,
	Conversations,
	ConversationStorage,
	Middleware,
} from 'tfx';

const first = BotGroup.make('first').add(
	Command.make('one', { name: 'one', error: Schema.Void }),
);
const second = BotGroup.make('second').add(
	Command.make('two', { name: 'two', error: Schema.Void }),
);
const bot = Bot.make('typed').add(first).add(second);
const one = BotBuilder.buildGroup(bot, 'first', (handlers) =>
	handlers.handle('one', () => Effect.void),
);
const two = BotBuilder.buildGroup(bot, 'second', (handlers) =>
	handlers.handle('two', () => Effect.void),
);

const router = BotRouter.make({
	bot,
	groups: [one, two],
	botUsername: 'typed_bot',
});
void router;

class ConversationDependency extends Context.Service<
	ConversationDependency,
	{ readonly value: string }
>()('type-test/ConversationDependency') {}
class BeforeConversationDependency extends Context.Service<
	BeforeConversationDependency,
	{ readonly beforeConversation: true }
>()('type-test/BeforeConversationDependency') {}
const declaration = Conversation.make('typed-conversation', {
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
	error: Schema.Void,
});
const built = ConversationBuilder.done(
	ConversationBuilder.make(declaration).step('input', {
		enter: () => Effect.asVoid(ConversationDependency),
		onInput: () => Effect.succeed(ConversationBuilder.complete()),
	}),
);
const typed = BotRouter.make({
	bot,
	groups: [one, two],
	conversations: [built],
	botUsername: 'typed_bot',
	beforeConversation: () => Effect.as(BeforeConversationDependency, undefined),
});
const requirementsProof: Effect.Effect<
	BotRouter.Router,
	never,
	| ConversationDependency
	| BeforeConversationDependency
	| Conversations.Conversations
	| ConversationStorage.ConversationStorage
	| Middleware.MiddlewareRegistry
> = typed;
void requirementsProof;
