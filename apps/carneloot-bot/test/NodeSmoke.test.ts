import * as NodeHttpClient from '@effect/platform-node/NodeHttpClient';
import { Effect, Layer } from 'effect';
import * as Redacted from 'effect/Redacted';
import { DispatchOutcome } from 'tfx';
import { BotRuntime } from 'tfx/BotRuntime';
import { JobRuntime } from 'tfx/JobRuntime';
import { UpdateDeduplicator } from 'tfx/UpdateDeduplicator';
import * as UpdateDelivery from 'tfx/UpdateDelivery';
import { describe, expect, it } from 'vitest';

import type { AppConfigService } from '../src/Config.js';
import { JobWorker } from '../src/JobWorker.js';
import * as Layers from '../src/Layers.js';
import { NotificationRepository } from '../src/ports/NotificationRepository.js';
import * as Production from '../src/Production.js';
import * as Router from '../src/Router.js';

const config: AppConfigService = {
	botToken: Redacted.make('test'),
	databaseUrl: Redacted.make('postgres://unused'),
	botId: 'carneloot',
	botUsername: 'carneloot_bot',
	pollingTimeoutSeconds: 30,
	pollingRetryDelayMillis: 100,
	dispatchCapacity: 8,
	dispatchConcurrency: 2,
	jobIdleMillis: 100,
	jobLeaseMillis: 30_000,
	jobHeartbeatMillis: 10_000,
	dedupLeaseMillis: 30_000,
	dedupHeartbeatMillis: 10_000,
	dedupWaitMillis: 1_000,
	dedupRetentionMillis: 86_400_000,
	tfxSchema: 'tfx',
	tfxTablePrefix: 'smoke_',
};
describe('portable Node composition', () => {
	it('acquires manual runtime services under Node HTTP without PG/network', async () => {
		const infrastructure = Layer.mergeAll(
			Layer.succeed(JobRuntime, {
				schedule: () => Effect.die('unused'),
				runOne: () => Effect.succeed(undefined),
				problems: Effect.succeed([]),
				cancel: () => Effect.die('unused'),
				releaseFailed: () => Effect.die('unused'),
			}),
			Layer.succeed(NotificationRepository, {
				recoverAllExpired: () => Effect.succeed(0),
			} as never),
			Layer.succeed(UpdateDeduplicator, {
				diagnostics: { mode: 'durable', backend: 'node-smoke' },
				claim: () =>
					Effect.succeed({
						_tag: 'Acquired',
						token: { updateId: 1, generation: 1 },
					}),
				heartbeat: () => Effect.succeed(true),
				complete: () => Effect.succeed(true),
				release: () => Effect.succeed(true),
			}),
			NodeHttpClient.layerFetch,
		) as never;
		const graph = Layers.core(config, {
			delivery: UpdateDelivery.manual,
			router: { route: () => Effect.succeed(DispatchOutcome.handled) },
			infrastructure,
		});
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const context = yield* Layer.build(graph);
					const outcome = yield* Effect.provide(
						Effect.flatMap(BotRuntime, (runtime) =>
							runtime.dispatch({ update_id: 1 } as never),
						),
						context,
					);
					expect(outcome).toEqual(DispatchOutcome.handled);
					const worker = yield* Effect.provide(JobWorker, context);
					expect(worker.diagnostics.startupProblems).toEqual([]);
				}),
			) as Effect.Effect<void, unknown, never>,
		);
		expect(Router.accountHandlers.entries).toHaveLength(1);
		expect(Router.petHandlers.entries).toHaveLength(2);
		expect(Router.petFoodHandlers.entries).toHaveLength(4);
		expect(Router.conversations).toHaveLength(4);
		const polling = Production.pollingOptions(config);
		expect(polling.commands).toEqual([
			{
				command: 'cadastrar',
				description: 'Cadastrar ou atualizar seu perfil',
			},
			{ command: 'adicionar_pet', description: 'Adicionar um pet' },
			{ command: 'listar_pets', description: 'Listar seus pets' },
			{
				command: 'configurar_inicio_dia',
				description: 'Configurar início do dia do pet',
			},
			{
				command: 'configurar_atraso_notificacao',
				description: 'Configurar atraso das notificações',
			},
			{ command: 'status_racao', description: 'Consultar o status de ração' },
			{ command: 'colocar_racao', description: 'Registrar ração para um pet' },
		]);
		expect(polling.languageCode).toBe('pt');
		expect(
			polling.commands.some(({ command }) => String(command) === 'cancelar'),
		).toBe(false);
		expect(polling.allowedUpdates).toContain('callback_query');
		expect(polling.allowedUpdates).toContain('message_reaction');
	});
});
