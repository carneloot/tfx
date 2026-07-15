import { Context, Effect, Layer } from 'effect';
import { Bot, BotRuntime, UpdateDeduplicator, UpdateDelivery } from 'tfx';

import { UpdateSource } from '../src/internal/update-source/UpdateSource.js';
class Infra extends Context.Service<Infra, { readonly value: string }>()(
	'types/RuntimeInfra',
) {}
type DeliveryError = { readonly _tag: 'DeliveryError' };
const source = Layer.effect(
	UpdateSource,
	Effect.flatMap(Infra, () =>
		Effect.fail({ _tag: 'DeliveryError' } as DeliveryError),
	),
);
const delivery = UpdateDelivery.make({ id: 'typed', layer: source });
const runtime: Layer.Layer<
	BotRuntime.BotRuntime,
	DeliveryError,
	Infra | UpdateDeduplicator.UpdateDeduplicator
> = BotRuntime.layer(Bot.make('bot'), { delivery });
void runtime;
// @ts-expect-error delivery is required
BotRuntime.layer(Bot.make('bot'), {});
// @ts-expect-error exactly one descriptor, never an array
BotRuntime.layer(Bot.make('bot'), { delivery: [delivery] });
