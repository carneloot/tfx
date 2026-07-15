import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { Scope } from "./internal/conversation/Scope.js"
import type { AfterCommit } from "./internal/conversation/Transition.js"
export type { Scope }
export interface ConversationRow { readonly scope: Scope; readonly conversationId: string; readonly version: number; readonly step: string; readonly state: unknown; readonly revision: number; readonly lastUpdateId: number | undefined; readonly expiresAt: number | undefined }
export type Mutation = { readonly _tag: "Persist"; readonly step: string; readonly state: unknown; readonly version?: number; readonly expiresAt?: number; readonly afterCommit?: AfterCommit } | { readonly _tag: "Delete"; readonly afterCommit?: AfterCommit }
export type TransitionResult<A> = { readonly _tag: "Applied"; readonly value: A; readonly row: ConversationRow | undefined; readonly afterCommit?: AfterCommit } | { readonly _tag: "Duplicate"; readonly row: ConversationRow } | { readonly _tag: "Stale"; readonly row: ConversationRow } | { readonly _tag: "Missing" } | { readonly _tag: "Expired" }
export class ConversationStorageError extends Error { readonly _tag = "ConversationStorageError"; constructor(readonly reason: "Conflict" | "InvariantViolation", message: string) { super(message) } }
export interface ConversationStorageService {
  readonly load: (scope: Scope) => Effect.Effect<ConversationRow | undefined>
  readonly create: (row: Omit<ConversationRow, "revision">, conflict: "fail" | "replace") => Effect.Effect<ConversationRow, ConversationStorageError>
  readonly transition: <A, E, R>(scope: Scope, updateId: number, expectedRevision: number, handler: (row: ConversationRow) => Effect.Effect<{ readonly value: A; readonly mutation: Mutation }, E, R>) => Effect.Effect<TransitionResult<A>, E | ConversationStorageError, R>
  readonly cancel: (scope: Scope) => Effect.Effect<boolean>
}
export class ConversationStorage extends Context.Service<ConversationStorage, ConversationStorageService>()("tfx/ConversationStorage") {}
