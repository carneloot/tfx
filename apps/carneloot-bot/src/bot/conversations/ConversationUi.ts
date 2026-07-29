import * as Effect from 'effect/Effect';
import { ConversationPrompt, MessageContext } from 'tfx';
import type * as ConversationChoice from 'tfx/ConversationChoice';

export const uniqueReplyOptions = <A>(
	options: ReadonlyArray<ConversationChoice.Option<A>>,
): ReadonlyArray<ConversationChoice.Option<A>> => {
	const totals = new Map<string, number>();
	for (const option of options)
		totals.set(option.label, (totals.get(option.label) ?? 0) + 1);
	const seen = new Map<string, number>();
	const labels = new Set<string>();
	return options.map((option) => {
		const occurrence = (seen.get(option.label) ?? 0) + 1;
		seen.set(option.label, occurrence);
		const base =
			(totals.get(option.label) ?? 0) > 1 || option.label === 'Cancelar'
				? `${option.label} (${occurrence})`
				: option.label;
		let label = base;
		let disambiguator = 1;
		while (labels.has(label)) label = `${base} (${disambiguator++})`;
		labels.add(label);
		return label === option.label ? option : { ...option, label };
	});
};

export const reply = (text: string) =>
	Effect.flatMap(MessageContext.MessageContext, (context) =>
		context.reply(text),
	).pipe(Effect.asVoid);

export const replyRemovingKeyboard = (text: string) =>
	Effect.flatMap(MessageContext.MessageContext, (context) =>
		context.reply(text, {
			reply_markup: ConversationPrompt.removeReplyKeyboard,
		}),
	).pipe(Effect.asVoid);

export const promptChoice = <A, R>(
	text: string,
	declaration: ConversationChoice.Choice<A, R>,
) =>
	Effect.gen(function* () {
		const context = yield* MessageContext.MessageContext;
		const markup = yield* ConversationPrompt.choice(declaration).pipe(
			Effect.orDie,
		);
		yield* context.reply(text, { reply_markup: markup });
	}).pipe(Effect.asVoid);
