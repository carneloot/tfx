import type * as Layer from 'effect/Layer';

import { appLayer } from '../src/Production.js';

type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;
type IsTagged<T> = [T] extends [{ readonly _tag: string }] ? true : false;
type IsUnknown<T> = unknown extends T
	? [T] extends [unknown]
		? true
		: false
	: false;

export type AppLayerHasNoRequirements = Assert<
	IsNever<Layer.Services<typeof appLayer>>
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
