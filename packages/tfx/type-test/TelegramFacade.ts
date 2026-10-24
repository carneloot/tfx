import * as Schema from 'effect/Schema';

import type { TelegramService } from '../src/Telegram.js';
import { Update } from '../src/TelegramSchemas.js';

// Webhook adapters can validate updates without a runtime or schema services.
const update: typeof Update.Type = Schema.decodeUnknownSync(Update)({
	update_id: 1,
});
void update;

declare const telegram: TelegramService;

// No-payload methods accept omitted payloads.
telegram.getMe();
telegram.getUpdates();

// Required payload and representative generated operation beyond initial six.
telegram.sendMessage({ chat_id: 1, text: 'hello' });
telegram.getChat({ chat_id: '@effect' });

// Telegram InputFile supports existing IDs, remote URLs, and uploads.
telegram.sendDocument({ chat_id: 1, document: 'telegram-file-id' });
telegram.sendDocument({ chat_id: 1, document: 'https://example.com/file.pdf' });
telegram.sendDocument({ chat_id: 1, document: new Blob(['file']) });

// @ts-expect-error sendMessage payload is required
telegram.sendMessage();
// @ts-expect-error sendDocument document is required
telegram.sendDocument({ chat_id: 1 });
