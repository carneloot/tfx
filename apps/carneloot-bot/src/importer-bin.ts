import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { Command } from 'effect/unstable/cli';

import packageJson from '../package.json' with { type: 'json' };
import { command } from './importer/Command.js';
import * as Observability from './importer/Observability.js';
import * as Platform from './importer/Platform.js';

Command.run(command, { version: packageJson.version }).pipe(
	Effect.provide(Layer.merge(Observability.layer, Platform.layer)),
	BunRuntime.runMain,
);
