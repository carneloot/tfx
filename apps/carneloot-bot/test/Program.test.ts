import { Effect, Layer, Tracer } from 'effect';
import { BotRuntime, type BotRuntimeSourceError } from 'tfx/BotRuntime';
import { JobStoreError } from 'tfx/JobStore';
import * as UpdateDeduplicator from 'tfx/UpdateDeduplicator';
import { describe, expect, it } from 'vitest';

import { JobWorker, type JobWorkerError } from '../src/JobWorker.js';
import * as Program from '../src/Program.js';

const bot = (awaitEffect: Effect.Effect<void, BotRuntimeSourceError>) =>
	Layer.succeed(BotRuntime, {
		dispatch: () => Effect.die('unused'),
		await: awaitEffect,
	});
const worker = (awaitEffect: Effect.Effect<void, JobWorkerError>) =>
	Layer.succeed(JobWorker, {
		await: awaitEffect,
		diagnostics: {
			recoveredDeliveries: 0,
			startupProblems: [],
			failedJobIds: [],
			quarantinedJobIds: [],
		},
		problems: Effect.succeed([]),
	});
const makeSpanCollector = () => {
	const spans: Array<Tracer.Span> = [];
	return {
		spans,
		tracer: Tracer.make({
			span: (options) => {
				const span = new Tracer.NativeSpan(options);
				spans.push(span);
				return span;
			},
		}),
	};
};
describe('Program', () => {
	it('refuses non-durable deduplication', async () => {
		const exit = await Effect.runPromiseExit(
			Effect.provide(
				Program.run,
				Layer.mergeAll(
					bot(Effect.never),
					worker(Effect.never),
					UpdateDeduplicator.layerNoop,
				),
			),
		);
		expect(exit._tag).toBe('Failure');
	});
	it('fails release health on quarantined jobs with identities', async () => {
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.result(Program.releaseSmokeHealth),
				Layer.succeed(JobWorker, {
					await: Effect.never,
					diagnostics: {
						recoveredDeliveries: 0,
						startupProblems: [],
						failedJobIds: [],
						quarantinedJobIds: ['q1'],
					},
					problems: Effect.succeed([
						{ id: 'q1', status: 'quarantined' } as never,
					]),
				}),
			),
		);
		expect(result).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'ReleaseSmokeHealthError', quarantinedJobIds: ['q1'] },
		});
	});

	it('releases fromLayer resources in reverse order after worker failure', async () => {
		const events: Array<string> = [];
		const managed = <A>(name: string, value: A) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					events.push(`acquire:${name}`);
					return value;
				}),
				() => Effect.sync(() => void events.push(`release:${name}`)),
			);
		const botLayer = Layer.effect(
			BotRuntime,
			managed('bot', {
				dispatch: () => Effect.die('unused'),
				await: Effect.never,
			}),
		);
		const workerLayer = Layer.effect(
			JobWorker,
			managed('worker', {
				await: Effect.fail(
					new JobStoreError('PersistenceFailure', 'worker failed'),
				),
				diagnostics: {
					recoveredDeliveries: 0,
					startupProblems: [],
					failedJobIds: [],
					quarantinedJobIds: [],
				},
				problems: Effect.succeed([]),
			}),
		);
		const durableLayer = Layer.effect(
			UpdateDeduplicator.UpdateDeduplicator,
			managed('deduplication', {
				diagnostics: { mode: 'durable', backend: 'test' },
			} as never),
		);

		const result = await Effect.runPromise(
			Effect.result(
				Program.fromLayer(Layer.mergeAll(botLayer, workerLayer, durableLayer)),
			),
		);

		expect(result).toMatchObject({
			_tag: 'Failure',
			failure: { _tag: 'JobStoreError', reason: 'PersistenceFailure' },
		});
		expect(events).toEqual([
			'acquire:bot',
			'acquire:worker',
			'acquire:deduplication',
			'release:deduplication',
			'release:worker',
			'release:bot',
		]);
	});

	it('traces retained lifecycle failures', async () => {
		const { spans, tracer } = makeSpanCollector();
		const durable = Layer.succeed(UpdateDeduplicator.UpdateDeduplicator, {
			diagnostics: { mode: 'durable', backend: 'test' },
		} as never);
		await Effect.runPromise(
			Effect.result(
				Effect.provideService(
					Effect.provide(
						Program.run,
						Layer.mergeAll(
							bot(Effect.never),
							worker(
								Effect.fail(
									new JobStoreError('PersistenceFailure', 'worker failed'),
								),
							),
							durable,
						),
					),
					Tracer.Tracer,
					tracer,
				),
			),
		);
		expect(spans.map((span) => span.name)).toContain('Program.run');
	});

	it('fails fast when either retained lifecycle fails', async () => {
		const durable = Layer.succeed(UpdateDeduplicator.UpdateDeduplicator, {
			diagnostics: { mode: 'durable', backend: 'test' },
		} as never);
		const result = await Effect.runPromise(
			Effect.result(
				Effect.provide(
					Program.run,
					Layer.mergeAll(
						bot(Effect.never),
						worker(
							Effect.fail(
								new JobStoreError('PersistenceFailure', 'worker failed'),
							),
						),
						durable,
					),
				),
			),
		);
		expect(result).toMatchObject({
			_tag: 'Failure',
			failure: {
				_tag: 'JobStoreError',
				reason: 'PersistenceFailure',
				message: 'worker failed',
			},
		});
	});
});
