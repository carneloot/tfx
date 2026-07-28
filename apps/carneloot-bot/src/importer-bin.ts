import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as Effect from 'effect/Effect';
import { Command } from 'effect/unstable/cli';

import packageJson from '../package.json' with { type: 'json' };
import { command } from './importer/Command.js';
import * as Platform from './importer/Platform.js';

Command.run(command, { version: packageJson.version }).pipe(
	Effect.provide(Platform.layer),
	BunRuntime.runMain,
);
