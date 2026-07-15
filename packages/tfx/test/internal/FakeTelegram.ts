import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Ref from 'effect/Ref';
import * as Semaphore from 'effect/Semaphore';

import { Telegram, type TelegramService } from '../../src/Telegram.js';
import {
	RecordedRequests,
	type RecordedRequest,
	type RecordedRequestsService,
} from './RecordedRequests.js';
export type Script =
	| {
			readonly method: string;
			readonly _tag: 'Success';
			readonly value: unknown;
	  }
	| {
			readonly method: string;
			readonly _tag: 'Failure';
			readonly error: unknown;
	  }
	| {
			readonly method: string;
			readonly _tag: 'Malformed';
			readonly value: unknown;
	  };
export const succeed = (method: string, value: unknown): Script => ({
	method,
	_tag: 'Success',
	value,
});
export const fail = (method: string, error: unknown): Script => ({
	method,
	_tag: 'Failure',
	error,
});
export const malformed = (method: string, value: unknown): Script => ({
	method,
	_tag: 'Malformed',
	value,
});
export const layer = (
	initial: ReadonlyArray<Script>,
): Layer.Layer<Telegram | RecordedRequests> =>
	Layer.effectContext(
		Effect.gen(function* () {
			const scripts = yield* Ref.make([...initial]);
			const requests = yield* Ref.make<Array<RecordedRequest>>([]);
			const semaphore = yield* Semaphore.make(1);
			const invoke = (method: string, input: unknown) =>
				semaphore.withPermit(
					Effect.gen(function* () {
						yield* Ref.update(requests, (values) => [
							...values,
							Object.freeze({ method, input }),
						]);
						const values = yield* Ref.get(scripts);
						const index = values.findIndex((entry) => entry.method === method);
						if (index < 0)
							return yield* Effect.die(
								new Error(`Unexpected Telegram request '${method}'`),
							);
						const [entry] = values.splice(index, 1);
						yield* Ref.set(scripts, values);
						if (entry!._tag === 'Failure')
							return yield* Effect.fail(entry!.error);
						return entry!.value;
					}),
				);
			const telegram = new Proxy(
				{},
				{
					get: (_target, property) => (input?: unknown) =>
						invoke(String(property), input),
				},
			) as TelegramService;
			const recorded: RecordedRequestsService = {
				all: Effect.map(Ref.get(requests), (values) =>
					Object.freeze([...values]),
				),
				method: (name) =>
					Effect.map(Ref.get(requests), (values) =>
						Object.freeze(values.filter((entry) => entry.method === name)),
					),
				count: (name) =>
					Effect.map(Ref.get(requests), (values) =>
						name === undefined
							? values.length
							: values.filter((entry) => entry.method === name).length,
					),
				assertConsumed: Effect.flatMap(Ref.get(scripts), (values) =>
					values.length === 0
						? Effect.void
						: Effect.die(
								new Error(
									`Unconsumed Telegram scripts: ${values.map((entry) => entry.method).join(', ')}`,
								),
							),
				),
			};
			return Context.make(Telegram, telegram).pipe(
				Context.add(RecordedRequests, recorded),
			);
		}),
	);
