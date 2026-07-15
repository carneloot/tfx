import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as Effect from 'effect/Effect';

import * as Production from './Production.js';
import * as Program from './Program.js';

BunRuntime.runMain(Effect.provide(Program.run, Production.appLayer));
