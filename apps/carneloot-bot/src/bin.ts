import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import * as AppConfig from './Config.js';
import * as Production from './Production.js';
import * as Program from './Program.js';

const graph = Layer.provide(Production.layer, AppConfig.layer);
BunRuntime.runMain(Effect.provide(Program.run, graph));
