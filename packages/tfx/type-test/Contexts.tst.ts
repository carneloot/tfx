import * as CallbackQueryContext from '../src/CallbackQueryContext.js';
import type {
	Message,
	Update,
} from '../src/internal/telegram/generated/TelegramApi.types.js';
import * as MessageContext from '../src/MessageContext.js';

declare const message: Message;
declare const callbackQuery: NonNullable<Update['callback_query']>;

const messageContext: MessageContext.MessageContextService =
	MessageContext.make(message);
const callbackContext: CallbackQueryContext.CallbackQueryContextService =
	CallbackQueryContext.make(callbackQuery);
void messageContext;
void callbackContext;

// These constructors model handler capabilities until BotBuilder tracks handler kinds.
// @ts-expect-error callback queries cannot construct message-handler context
MessageContext.make(callbackQuery);
// @ts-expect-error messages cannot construct callback-handler context
CallbackQueryContext.make(message);
