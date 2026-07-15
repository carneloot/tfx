import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

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
const generated = spawnSync("corepack", ["pnpm", ...args], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
if (generated.status !== 0) throw new Error(generated.stderr || `openapigen exited ${generated.status}`)
const normalizeLines = (value: string) => value.replace(/[ \t]+$/gm, "").replace(/\n*$/, "\n")
const warnings = normalizeLines(generated.stderr).trim().split("\n").filter(Boolean)
const warningAllowlist = new Set<string>([])
const unexpectedWarnings = warnings.filter((warning) => !warningAllowlist.has(warning))
if (unexpectedWarnings.length > 0) throw new Error(`unexpected openapigen warnings:\n${unexpectedWarnings.join("\n")}`)

const multipartFieldNames = new Set<string>()
for (const pathItem of Object.values(document.paths) as Array<Record<string, any>>) {
  for (const operation of Object.values(pathItem)) {
    const properties = operation.requestBody?.content?.["application/json"]?.schema?.properties ?? {}
    for (const [name, schema] of Object.entries(properties) as Array<[string, any]>) {
      if (schema.format === "binary" || schema.$ref?.endsWith("/InputFile") || /upload|InputFile/i.test(schema.description ?? "")) multipartFieldNames.add(name)
    }
  }
}

let normalized = normalizeLines(generated.stdout)
normalized = normalized.replaceAll("HttpClientRequest.bodyUrlParams(options.payload as any)", "HttpClientRequest.bodyJsonUnsafe(options.payload as any)")
normalized = normalized.replaceAll("HttpClientRequest.bodyFormData(options.payload as any)", "bodyTelegramPayload(options.payload as any)")
const unexpectedStatusPattern = /  const unexpectedStatus = \(response: HttpClientResponse\.HttpClientResponse\) =>[\s\S]*?\n  const withResponse =/
if (!unexpectedStatusPattern.test(normalized)) throw new Error("could not replace unexpected status decoder")
normalized = normalized.replace(unexpectedStatusPattern, `  const unexpectedStatus = (response: HttpClientResponse.HttpClientResponse) =>\n    Effect.flatMap(\n      HttpClientResponse.schemaBodyJson(APIResponseError)(response),\n      (cause) => Effect.fail(TelegramApiError(\"APIResponseError\", cause, response))\n    )\n  const withResponse =`)
const makeMarker = "export const make = (\n"
const helper = `const containsUpload = (value: unknown, seen = new Set<unknown>()): boolean => {\n  if (typeof Blob === \"function\" && value instanceof Blob) return true\n  if (typeof File === \"function\" && value instanceof File) return true\n  if (typeof value !== \"object\" || value === null || seen.has(value)) return false\n  seen.add(value)\n  return Object.values(value).some((item) => containsUpload(item, seen))\n}\nconst bodyTelegramPayload = (payload: Record<string, unknown>) => containsUpload(payload)\n  ? HttpClientRequest.bodyFormDataRecord(payload)\n  : HttpClientRequest.bodyJsonUnsafe(payload)\n\n`
if (!normalized.includes(makeMarker)) throw new Error("could not insert Telegram request body helper")
normalized = normalized.replace(makeMarker, helper + makeMarker)
const full = `// @ts-nocheck -- generated from pinned Photon OpenAPI; do not edit\n${normalized}`
const target = process.argv[2] ? resolve(process.argv[2]) : resolve(generatedDir, "TelegramApi.ts")
writeFileSync(target, full)

const types = [...full.matchAll(/^export type [^\n]+$/gm)].map(([line]) => line)
  .filter((line) => !line.startsWith("export type WithOptionalResponse"))
  .map((line) => line.replaceAll("Schema.Json", "Json"))
  .map((line) => {
    if (!line.includes("RequestFormData =")) return line
    for (const field of multipartFieldNames) line = line.replaceAll(`readonly "${field}": string`, `readonly "${field}": string | Blob`)
    return line
  })
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

const manifestFiles = [spec, ...patches.map((name) => resolve(root, "packages/tfx/openapi/patches", name))]
const manifest = manifestFiles.map((file) => `${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${basename(file)}`).join("\n") + "\n"
const manifestTarget = resolve(root, "packages/tfx/openapi/telegram-sources.sha256")
if (!process.argv[2]) writeFileSync(manifestTarget, manifest)
