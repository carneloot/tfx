export interface Options {
	readonly schema?: string;
	readonly tablePrefix?: string;
	readonly botId?: string;
}
export const defaults: Required<Options> = {
	schema: 'public',
	tablePrefix: 'tfx_',
	botId: 'default',
};
