import type * as Schema from 'effect/Schema';
import {
	CallbackData,
	ConversationChoice,
	ConversationInput,
	ConversationPrompt,
} from 'tfx';
declare const Decode: unique symbol;
declare const Encode: unique symbol;
declare const codec: Schema.ConstraintCodec<
	number,
	string,
	typeof Decode,
	typeof Encode
>;
const data = CallbackData.make('choice', codec);
const choice = ConversationChoice.make([{ label: 'one', value: 1 }], {
	callbackData: data,
});
type Requirements = (typeof choice)['_R'];
const requirements: Requirements = undefined as unknown as
	| typeof Decode
	| typeof Encode;
void requirements;
const prompt = ConversationPrompt.choice(choice);
void prompt;
const selected: ConversationChoice.ChoiceResult<number> =
	ConversationChoice.selected(1);
const cancelled: ConversationChoice.ChoiceResult<number> =
	ConversationChoice.cancelled;
void selected;
void cancelled;
declare const PetId: unique symbol;
type PetId = string & { readonly [PetId]: 'PetId' };
declare const petId: PetId;
const petInput = ConversationInput.choice(
	ConversationChoice.reply([{ label: 'Fido', value: petId }]),
);
const petResult: ConversationChoice.ChoiceResult<PetId> =
	undefined as unknown as ConversationInput.Decoded<typeof petInput>;
void petResult;
const booleanInput = ConversationInput.choice(
	ConversationChoice.boolean({ yes: 'Sim', no: 'Não' }),
);
const booleanResult: ConversationChoice.ChoiceResult<boolean> =
	undefined as unknown as ConversationInput.Decoded<typeof booleanInput>;
void booleanResult;
ConversationChoice.make([{ label: 'bad', value: 'one' }], {
	// @ts-expect-error callback choice value must match codec type
	callbackData: data,
});
