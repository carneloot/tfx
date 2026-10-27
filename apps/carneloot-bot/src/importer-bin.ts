import * as BunCrypto from '@effect/platform-bun/BunCrypto';
import * as BunRuntime from '@effect/platform-bun/BunRuntime';
import * as BunServices from '@effect/platform-bun/BunServices';
import { Command } from 'effect/cli';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import packageJson from '../package.json' with { type: 'json' };
import { command } from './importer/Command.js';
import * as Observability from './importer/Observability.js';

Command.run(command, { version: packageJson.version }).pipe(
	Effect.provide(
		Layer.mergeAll(Observability.layer, BunServices.layer, BunCrypto.layer),
	),
	BunRuntime.runMain,
);
