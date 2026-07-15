import type * as Layer from 'effect/Layer';

import type { UpdateSource } from './internal/update-source/UpdateSource.js';
const TypeId: unique symbol = Symbol.for('tfx/UpdateDelivery');
export interface UpdateDelivery<Id extends string, Error, Requirements> {
	readonly [TypeId]: typeof TypeId;
	readonly id: Id;
	readonly layer: Layer.Layer<UpdateSource, Error, Requirements>;
}
export const make = <const Id extends string, E, R>(options: {
	readonly id: Id;
	readonly layer: Layer.Layer<UpdateSource, E, R>;
}): UpdateDelivery<Id, E, R> =>
	Object.freeze({ [TypeId]: TypeId as typeof TypeId, ...options });
export type Error<D> = D extends UpdateDelivery<any, infer E, any> ? E : never;
export type Requirements<D> =
	D extends UpdateDelivery<any, any, infer R> ? R : never;
