export interface Scope {
	readonly botId: string;
	readonly chatId: number;
	readonly userId: number;
}
export const key = (scope: Scope): string =>
	`${scope.botId}:${scope.chatId}:${scope.userId}`;
