/** Structural contract required for values carried in public Effect error channels. */
export interface TaggedError {
	readonly _tag: string;
}
