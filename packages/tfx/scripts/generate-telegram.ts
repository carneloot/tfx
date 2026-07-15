import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

const root = resolve(import.meta.dirname, "../../..")
const generatedDir = resolve(root, "packages/tfx/src/internal/telegram/generated")
const specRepo = resolve(root, ".repos/telegram-api")
const pinnedPhotonSha = "80e0bd5d3d3155985c1a4281aec729b73e294055"
const actualPhotonSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: specRepo, encoding: "utf8" }).trim()
if (actualPhotonSha !== pinnedPhotonSha) throw new Error(`unexpected Photon SHA: ${actualPhotonSha}`)

const spec = resolve(specRepo, "specs/telegram-bot-api.openapi.json")
const document = JSON.parse(readFileSync(spec, "utf8"))
const required = new Set(["getMe", "deleteWebhook", "setMyCommands", "getUpdates", "sendMessage", "sendDocument"])
for (const item of Object.values(document.paths) as Array<Record<string, { operationId?: string }>>) {
  for (const operation of Object.values(item)) if (operation.operationId) required.delete(operation.operationId)
}
if (required.size > 0) throw new Error(`required Telegram operations missing: ${[...required].join(", ")}`)

const patches = ["001-server.json", "002-default-responses.json", "003-input-files.json"]
const args = ["exec", "openapigen", "--spec", spec, "--name", "TelegramApi", "--format", "httpclient", ...patches.flatMap((name) => ["--patch", resolve(root, "packages/tfx/openapi/patches", name)])]
const output = execFileSync("corepack", ["pnpm", ...args], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
const normalized = output.replace(/[ \t]+$/gm, "").replace(/\n*$/, "\n")
const full = `// @ts-nocheck -- generated from pinned Photon OpenAPI; do not edit\n${normalized}`
const target = process.argv[2] ? resolve(process.argv[2]) : resolve(generatedDir, "TelegramApi.ts")
writeFileSync(target, full)

const types = [...full.matchAll(/^export type [^\n]+$/gm)].map(([line]) => line)
  .filter((line) => !line.startsWith("export type WithOptionalResponse"))
  .map((line) => line.replaceAll("Schema.Json", "Json"))
  .map((line) => line.startsWith("export type SendDocumentRequestFormData =") ? line.replace('readonly "document": string', 'readonly "document": string | Blob') : line)
const interfaceStart = full.indexOf("export interface TelegramApi {")
const interfaceEnd = full.indexOf("\n}\n\nexport interface TelegramApiError", interfaceStart)
if (interfaceStart < 0 || interfaceEnd < 0) throw new Error("could not extract TelegramApi interface")
const apiInterface = full.slice(interfaceStart, interfaceEnd + 2)
  .replace(/^  readonly httpClient:.*\n/m, "")
  .replace(/typeof ([A-Za-z0-9_]+)\.(?:Encoded|Type)/g, "$1")
  .replace(/<Config extends OperationConfig>\(options: \{ readonly payload: ([^;]+); readonly config\?: Config \| undefined \}\) => Effect\.Effect<WithOptionalResponse<([^,]+), Config>,/g, "(options: { readonly payload: $1 }) => Effect.Effect<$2,")
  .replace(/<Config extends OperationConfig>\(options: \{ readonly config\?: Config \| undefined \} \| undefined\) => Effect\.Effect<WithOptionalResponse<([^,]+), Config>,/g, "(options?: { readonly payload?: Record<string, never> }) => Effect.Effect<$1,")
const typeOnly = `// generated type-only surface; do not edit\nimport type * as Effect from "effect/Effect"\nimport type { Json, SchemaError } from "effect/Schema"\nimport type * as HttpClientError from "effect/unstable/http/HttpClientError"\nimport type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"\nexport interface OperationConfig { readonly includeResponse?: boolean | undefined }\nexport type WithOptionalResponse<A, Config extends OperationConfig> = Config extends { readonly includeResponse: true } ? [A, HttpClientResponse.HttpClientResponse] : A\n${types.join("\n")}\n${apiInterface}\n`
writeFileSync(resolve(dirname(target), "TelegramApi.types.ts"), typeOnly)

const runtimeTarget = resolve(dirname(target), "TelegramApi.runtime.js")
execFileSync("bun", ["build", target, "--outfile", runtimeTarget, "--target=node", "--format=esm", "--external=effect", "--external=effect/*"], { cwd: root, stdio: "inherit" })
writeFileSync(runtimeTarget, readFileSync(runtimeTarget, "utf8").replace(/^\/\/ .*TelegramApi\.ts$/m, "// generated TelegramApi runtime"))
writeFileSync(resolve(dirname(target), "TelegramApi.runtime.d.ts"), `// generated runtime bridge; do not edit\nimport type * as Effect from "effect/Effect"\nimport type * as Schema from "effect/Schema"\nimport type * as HttpClient from "effect/unstable/http/HttpClient"\nimport type { TelegramApi, BotCommand as BotCommandType, Message as MessageType, Update as UpdateType, User as UserType } from "./TelegramApi.types.js"\nexport declare const make: (client: HttpClient.HttpClient, options?: { readonly transformClient?: ((client: HttpClient.HttpClient) => Effect.Effect<HttpClient.HttpClient>) | undefined }) => TelegramApi\nexport declare const BotCommand: Schema.Schema<BotCommandType>\nexport declare const Message: Schema.Schema<MessageType>\nexport declare const Update: Schema.Schema<UpdateType>\nexport declare const User: Schema.Schema<UserType>\n`)
