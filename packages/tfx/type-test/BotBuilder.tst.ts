import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import {
	Bot,
	BotBuilder,
	BotGroup,
	CallbackQueryContext,
	Command,
	CommandInput,
	MessageContext,
	Middleware,
	UpdateContext,
} from 'tfx';

class Infra extends Context.Service<Infra, { readonly value: string }>()(
	'test/Infra',
) {}
class CurrentUser extends Context.Service<
	CurrentUser,
	{ readonly id: number }
>()('test/CurrentUser') {}
class CurrentAdmin extends Context.Service<
	CurrentAdmin,
	{ readonly id: number }
>()('test/CurrentAdmin') {}
class AuthError extends Schema.TaggedErrorClass<AuthError>()('AuthError', {}) {}
const user = Middleware.make('user', {
	scope: 'global',
	provides: CurrentUser,
	error: AuthError,
});
const admin = Middleware.make('admin', {
	scope: 'command',
	provides: CurrentAdmin,
	requires: [CurrentUser],
	error: Schema.Void,
});
Command.make('invalid-order', {
	name: 'invalid',
	// @ts-expect-error CurrentUser is not available before user middleware
	middleware: [admin, user],
	error: Schema.Void,
});
Command.make('invalid-kind', {
	name: 'invalid',
	error: Schema.Void,
	// @ts-expect-error commands are always message handlers
	updateKinds: ['callback_query'],
});
class Allowed extends Schema.TaggedErrorClass<Allowed>()('Allowed', {}) {}

const petInput = CommandInput.none as CommandInput.CommandInput<{
	readonly name: string;
}>;
const pets = BotGroup.make('pets')
	.add(
		Command.make('addPet', {
			name: 'add_pet',
			input: petInput,
			error: Allowed,
			middleware: [user, admin],
		}),
	)
	.add(Command.make('listPets', { name: 'list_pets', error: Schema.Void }));
const app = Bot.make('App').add(pets);

const live = BotBuilder.group(app, 'pets', (handlers) =>
	handlers
		.handle('addPet', (input) => {
			const _inferred: string = input.name;
			return Effect.all([
				Infra,
				UpdateContext.UpdateContext,
				MessageContext.MessageContext,
				CurrentUser,
				CurrentAdmin,
			]).pipe(Effect.as(_inferred));
		})
		.handle('listPets', (_input) =>
			Effect.as(CallbackQueryContext.CallbackQueryContext, undefined),
		),
);
const _requirements: Layer.Layer<
	any,
	never,
	| Infra
	| Middleware.MiddlewareRegistry
	| CallbackQueryContext.CallbackQueryContext
> = live;
const plainGroup = BotGroup.make('plain').add(
	Command.make('ping', { name: 'ping', error: Schema.Void }),
);
const plainBot = Bot.make('Plain').add(plainGroup);
const plainLive: Layer.Layer<any, never, never> = BotBuilder.group(
	plainBot,
	'plain',
	(handlers) => handlers.handle('ping', () => Effect.void),
);
void plainLive;

declare const registry: Middleware.MiddlewareRegistryService;
const typedEntries = BotBuilder.group(app, 'pets', (handlers) => {
	const first = handlers.handle('addPet', () => Effect.fail(new Allowed()));
	const invoked: Effect.Effect<never, Allowed | AuthError, never> =
		first._entries[0]!.invoke(registry, { name: 'pet' });
	void invoked;
	return first.handle('listPets', () => Effect.void);
});
void typedEntries;

// @ts-expect-error unknown group
BotBuilder.group(app, 'missing', (handlers) => handlers);
BotBuilder.group(
	app,
	'pets',
	// @ts-expect-error missing listPets implementation
	(handlers) => handlers.handle('addPet', () => Effect.void),
);
BotBuilder.group(app, 'pets', (handlers) =>
	handlers
		.handle('addPet', () => Effect.void)
		// @ts-expect-error duplicate implementation
		.handle('addPet', () => Effect.void),
);
BotBuilder.group(app, 'pets', (handlers) =>
	handlers
		// @ts-expect-error unknown command
		.handle('removePet', () => Effect.void),
);
BotBuilder.group(app, 'pets', (handlers) =>
	handlers
		// @ts-expect-error undeclared handler error
		.handle('addPet', () => Effect.fail('bad'))
		.handle('listPets', () => Effect.void),
);

// @ts-expect-error duplicate command declaration
pets.add(Command.make('addPet', { name: 'another', error: Schema.Void }));
// @ts-expect-error duplicate group declaration
app.add(pets);
