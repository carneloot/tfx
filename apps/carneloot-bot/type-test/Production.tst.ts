import type * as Layer from 'effect/Layer';
import type { BotRuntime } from 'tfx/BotRuntime';
import type { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';

import type { JobWorker } from '../src/JobWorker.js';
import { appLayer } from '../src/Production.js';

const fullyProvided: Layer.Layer<
	BotRuntime | JobWorker | UpdateDeduplicator,
	unknown,
	never
> = appLayer;
void fullyProvided;
