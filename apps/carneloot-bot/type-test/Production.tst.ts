import type * as Crypto from 'effect/Crypto';
import type * as Layer from 'effect/Layer';
import { BotRuntime } from 'tfx/BotRuntime';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';

import { JobWorker } from '../src/JobWorker.js';
import { appLayer } from '../src/Production.js';

type Assert<T extends true> = T;
type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;
type IsNever<T> = [T] extends [never] ? true : false;
type IsTagged<T> = [T] extends [{ readonly _tag: string }] ? true : false;
type IsUnknown<T> = unknown extends T
	? [T] extends [unknown]
		? true
		: false
	: false;

export type AppLayerRequiresCrypto = Assert<
	Equal<Layer.Services<typeof appLayer>, Crypto.Crypto>
>;
export type AppLayerErrorsAreTagged = Assert<
	IsTagged<Layer.Error<typeof appLayer>>
>;
export type AppLayerErrorsAreConcrete = Assert<
	IsNever<Layer.Error<typeof appLayer>> extends false ? true : false
>;
export type AppLayerErrorsAreNotUnknown = Assert<
	IsUnknown<Layer.Error<typeof appLayer>> extends false ? true : false
>;
export type AppLayerOutputIsNarrow = Assert<
	Equal<
		Layer.Success<typeof appLayer>,
		BotRuntime | JobWorker | UpdateDeduplicator
	>
>;
