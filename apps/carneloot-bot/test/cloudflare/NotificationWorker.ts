import * as Schema from 'effect/Schema';

import * as Application from '../../src/cloudflare/Runtime.js';
import type { Env } from '../../src/cloudflare/Runtime.js';
import { BotId } from '../../src/domain/Ids.js';
import * as Hosting from '../../src/http/Hosting.js';

/** The same application-level fetch mount used by the production composition. */
export default {
	fetch: (request: Request, env: Env) =>
		Hosting.fetch(
			request,
			Schema.decodeUnknownSync(BotId)('carneloot'),
			Application.layer(env),
		),
};
