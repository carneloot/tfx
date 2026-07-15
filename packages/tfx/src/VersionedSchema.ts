import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export class VersionedSchemaError extends Error {
  readonly _tag = "VersionedSchemaError"
  constructor(readonly reason: "InvalidVersion" | "MissingMigration" | "DecodeFailure", message: string, readonly cause?: unknown) { super(message) }
}
export interface Version<V extends number, A> { readonly version: V; readonly schema: Schema.Schema<A> }
export interface Migration { readonly from: number; readonly to: number; readonly migrate: (value: any) => any }
export interface History<Versions extends ReadonlyArray<Version<number, any>>> {
  readonly versions: Versions
  readonly migrations: ReadonlyArray<Migration>
  readonly latest: Versions[number]
  readonly migrate: (version: number, value: unknown) => Effect.Effect<unknown, VersionedSchemaError | Schema.SchemaError>
  readonly decode: (value: { readonly version: number; readonly state: unknown }) => Effect.Effect<unknown, VersionedSchemaError | Schema.SchemaError>
  pipe: <B>(f: (self: History<Versions>) => B) => B
}
type Last<V extends ReadonlyArray<unknown>> = V extends readonly [...infer _, infer L] ? L : never
export type Latest<H> = H extends History<infer V> ? Last<V> extends Version<number, infer A> ? A : never : never
export const version = <const V extends number, A>(value: V, schema: Schema.Schema<A>): Version<V, A> => {
  if (!Number.isInteger(value) || value <= 0) throw new VersionedSchemaError("InvalidVersion", `Version must be a positive integer; received ${value}`)
  return Object.freeze({ version: value, schema })
}
const build = <V extends ReadonlyArray<Version<number, any>>>(versions: V, migrations: ReadonlyArray<Migration>): History<V> => {
  const numbers = versions.map((item) => item.version)
  for (let i = 0; i < numbers.length; i++) if (numbers[i] !== numbers[0]! + i) throw new VersionedSchemaError("InvalidVersion", "Versions must be unique and contiguous")
  const latest = versions.at(-1)!
  const migrate = (from: number, value: unknown): Effect.Effect<unknown, VersionedSchemaError | Schema.SchemaError> => {
    const source = versions.find((item) => item.version === from)
    if (source === undefined) return Effect.fail(new VersionedSchemaError("MissingMigration", `Unknown version ${from}`))
    return Effect.flatMap(Schema.decodeUnknownEffect(source.schema)(value) as Effect.Effect<any, Schema.SchemaError, never>, (decoded): Effect.Effect<unknown, Schema.SchemaError | VersionedSchemaError, never> => {
      let current = decoded
      for (let v = from; v < latest.version; v++) {
        const migration = migrations.find((item) => item.from === v && item.to === v + 1)
        if (migration === undefined) return Effect.fail(new VersionedSchemaError("MissingMigration", `Missing migration ${v}→${v + 1}`))
        try { current = migration.migrate(current) } catch (cause) { return Effect.fail(new VersionedSchemaError("DecodeFailure", `Migration ${v}→${v + 1} failed`, cause)) }
      }
      return Schema.decodeUnknownEffect(latest.schema)(current) as Effect.Effect<unknown, Schema.SchemaError, never>
    })
  }
  const self: History<V> = { versions: Object.freeze([...versions]) as unknown as V, migrations: Object.freeze([...migrations]), latest, migrate, decode: (value) => migrate(value.version, value.state), pipe: (f) => f(self) }
  return Object.freeze(self)
}
export const history = <V extends Version<number, any>>(first: V): History<readonly [V]> => build([first], [])
export const to = <V extends ReadonlyArray<Version<number, any>>, Next extends Version<number, any>>(next: Next, migrate: (value: Last<V> extends Version<number, infer A> ? A : never) => Next extends Version<number, infer B> ? B : never) =>
  (self: History<V>): History<readonly [...V, Next]> => {
    const previous = self.latest.version
    if (next.version !== previous + 1) throw new VersionedSchemaError("InvalidVersion", `Expected version ${previous + 1}; received ${next.version}`)
    return build([...self.versions, next], [...self.migrations, { from: previous, to: next.version, migrate }])
  }
