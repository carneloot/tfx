import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as Layer from 'effect/Layer';

import * as Observability from './Observability.js';
import * as Production from './Production.js';
import * as Program from './Program.js';

BunRuntime.runMain(
	Program.fromLayer(
		Layer.provideMerge(Production.appLayer, Observability.layer),
	),
);
