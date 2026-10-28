import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import { MessageContext, MessageHandlerResult, Telegram } from 'tfx';

type Input = { readonly input?: string };

export const start = Effect.fn('GeneralHandlers.start')(function* () {
	const context = yield* MessageContext.MessageContext;
	yield* context.reply('É nóis');
});

export const ping = Effect.fn('GeneralHandlers.ping')(function* ({
	input,
}: Input) {
	const context = yield* MessageContext.MessageContext;
	const milliseconds =
		input !== undefined && /^\d+$/u.test(input) ? Number(input) : NaN;
	const duration =
		Number.isSafeInteger(milliseconds) && milliseconds <= 10_000
			? Duration.millis(milliseconds)
			: undefined;
	if (duration !== undefined) yield* Effect.sleep(duration);
	yield* context.replyToCurrent(
		duration === undefined ? 'pong' : `pong ${Duration.format(duration)}`,
	);
});

const whatsHelp =
	'Envie uma mensagem no formato (00) 0 0000-0000 [mensagem]. A mensagem, os espaços e os algarismos não numéricos são opcionais';
// Keep the country code separate: a local number with DDD 55 still needs +55.
const phone =
	/^(?:(?:\+|00)?55\s*)?((?:\([1-9]\d\)|[1-9]\d)\s*(?:9\s*\d|[2-9])\d{3}[-\s]?\d{4})(?:\s+([\s\S]*))?$/u;
export const whats = Effect.fn('GeneralHandlers.whats')(function* ({
	input,
}: Input) {
	const context = yield* MessageContext.MessageContext;
	const match = phone.exec(input ?? '');
	if (match?.[1] === undefined) {
		yield* context.reply(whatsHelp);
		return;
	}
	const number = `55${match[1].replace(/\D/gu, '')}`;
	const message = match[2];
	const suffix = message
		? `?text=${encodeURIComponent(message).replace(/!/gu, '%21')}`
		: '';
	yield* context.reply(`https://wa.me/${number}${suffix}`);
});

const missingWater = 'Me envie a quantidade inicial de água em ml. 😄';
const missingCoffee = 'Me envie a quantidade de café em g. 😄';
const invalidRatio =
	'Proporção de café para quantidade água invalida. Por favor envie um valor na unidade g/L';

// Bare quantities retain the legacy ml, g and g/L defaults. Common metric
// equivalents need no unit library; unsupported dimensions produce guidance.
const quantity = (
	input: string | undefined,
	units: Readonly<Record<string, number>>,
	defaultUnit: string,
) => {
	const match = /^(\d+(?:[.,]\d+)?|[.,]\d+)([a-zA-Z/]+)?$/u.exec(input ?? '');
	if (match?.[1] === undefined) return undefined;
	const value =
		Number(match[1].replace(',', '.')) *
		(units[(match[2] ?? defaultUnit).toLowerCase()] ?? NaN);
	return Number.isFinite(value) && value > 0 ? value : undefined;
};
const rounded = (value: number, precision = 1) =>
	String(Number((Math.round(value / precision) * precision).toFixed(2)));

const pourTable = (waterMl: number, coffeeG: number) => {
	const rows: ReadonlyArray<readonly [string, string]> = [
		['Qtde.', 'Tempo'],
		[`${rounded(coffeeG * 2)} g a ${rounded(coffeeG * 3)} g`, 'Esperar 45 s'],
		[`Até ${rounded(waterMl * 0.6)} g`, 'Durante 30 s'],
		[`Até ${rounded(waterMl)} g`, 'Durante 30 s'],
	];
	const amountWidth = Math.max(...rows.map(([amount]) => amount.length));
	const timeWidth = Math.max(...rows.map(([, time]) => time.length));
	const line = (left: string, middle: string, right: string) =>
		`${left}${'─'.repeat(amountWidth + 2)}${middle}${'─'.repeat(timeWidth + 2)}${right}`;
	const body = rows.map(
		([amount, time]) =>
			`│ ${amount.padStart(amountWidth)} │ ${time.padStart(timeWidth)} │`,
	);
	return `<pre>${[
		line('┌', '─', '┐'),
		`│${'Água'.padStart(Math.floor((amountWidth + timeWidth + 9) / 2)).padEnd(amountWidth + timeWidth + 5)}│`,
		line('├', '┬', '┤'),
		body[0],
		line('├', '┼', '┤'),
		body[1],
		line('├', '┼', '┤'),
		body[2],
		line('├', '┼', '┤'),
		body[3],
		line('└', '┴', '┘'),
	].join('\n')}</pre>`;
};

const coffee = Effect.fn('GeneralHandlers.coffee')(function* (
	{ input }: Input,
	inverse: boolean,
) {
	const context = yield* MessageContext.MessageContext;
	const parts = (input ?? '').trim().split(/\s+/u);
	const amount = inverse
		? quantity(parts[0], { g: 1, kg: 1000, mg: 0.001 }, 'g')
		: quantity(parts[0], { ml: 1, l: 1000, cl: 10, dl: 100 }, 'ml');
	if (amount === undefined) {
		yield* context.reply(inverse ? missingCoffee : missingWater);
		return;
	}
	const ratio =
		parts[1] === undefined
			? 60
			: quantity(parts[1], { 'g/l': 1, 'g/ml': 1000, 'kg/l': 1000 }, 'g/l');
	if (ratio === undefined || parts.length > 2) {
		yield* context.reply(invalidRatio);
		return;
	}
	const waterMl = inverse ? (amount * 1000) / ratio : amount;
	const coffeeG = inverse ? amount : (amount * ratio) / 1000;
	if (
		!Number.isFinite(waterMl) ||
		!Number.isFinite(coffeeG) ||
		waterMl <= 0 ||
		coffeeG <= 0
	) {
		yield* context.reply(invalidRatio);
		return;
	}
	yield* context.reply(
		inverse
			? `Quantidade de água: ${waterMl < 1000 ? `${rounded(waterMl)} ml` : `${rounded(waterMl / 1000, 0.01)} l`}`
			: `Quantidade de café: ${rounded(coffeeG)} g`,
	);
	yield* context.reply(pourTable(waterMl, coffeeG), { parse_mode: 'HTML' });
});

export const cafe = (input: Input) => coffee(input, false);
export const cafeInv = (input: Input) => coffee(input, true);

export const hello = Effect.fn('GeneralHandlers.hello')(function* (
	text: string,
) {
	if (!/hello/iu.test(text)) return MessageHandlerResult.unmatched;
	const context = yield* MessageContext.MessageContext;
	const telegram = yield* Telegram.Telegram;
	yield* telegram.sendPhoto({
		chat_id: context.chatId,
		photo: 'https://i.kym-cdn.com/photos/images/original/001/475/422/473.jpg',
		...(context.messageThreadId === undefined
			? {}
			: { message_thread_id: context.messageThreadId }),
		...(context.businessConnectionId === undefined
			? {}
			: { business_connection_id: context.businessConnectionId }),
	});
	return MessageHandlerResult.handled;
});
