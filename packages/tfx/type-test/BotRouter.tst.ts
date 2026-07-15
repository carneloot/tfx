import { Effect } from 'effect';
import { Bot, BotBuilder, BotGroup, BotRouter, Command } from 'tfx';

const first = BotGroup.make('first').add(Command.make('one', { name: 'one' }));
const second = BotGroup.make('second').add(
	Command.make('two', { name: 'two' }),
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
