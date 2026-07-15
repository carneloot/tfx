export interface Scope {
	readonly botId: string;
	readonly chatId: number;
	readonly userId: number;
}
export const key = (scope: Scope): string =>
	JSON.stringify([scope.botId, scope.chatId, scope.userId]);
