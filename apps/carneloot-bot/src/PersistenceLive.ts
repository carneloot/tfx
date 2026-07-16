import * as TfxPostgres from '@tfx/postgres/TfxPostgres';
import * as Layer from 'effect/Layer';

import type { AppConfigService } from './Config.js';
import * as RepositoriesLive from './postgres/RepositoriesLive.js';

export const layer = (config: AppConfigService) =>
	Layer.merge(
		TfxPostgres.layer({
			schema: config.tfxSchema,
			tablePrefix: config.tfxTablePrefix,
			botId: config.botId,
		}),
		RepositoriesLive.layer,
	);
