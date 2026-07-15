import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "../../..")
const spec = resolve(root, ".repos/telegram-api/specs/telegram-bot-api.openapi.json")
const document = JSON.parse(readFileSync(spec, "utf8"))
const required = new Set(["getMe", "deleteWebhook", "setMyCommands", "getUpdates", "sendMessage", "sendDocument"])
for (const item of Object.values(document.paths) as Array<Record<string, { operationId?: string }>>) {
  for (const operation of Object.values(item)) if (operation.operationId) required.delete(operation.operationId)
}
if (required.size > 0) throw new Error(`required Telegram operations missing: ${[...required].join(", ")}`)
const patches = ["001-server.json", "002-default-responses.json", "003-input-files.json"]
const args = ["exec", "openapigen", "--spec", spec, "--name", "TelegramApi", "--format", "httpclient", ...patches.flatMap((name) => ["--patch", resolve(root, "packages/tfx/openapi/patches", name)])]
const generated = execFileSync("pnpm", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
writeFileSync(process.argv[2] ? resolve(process.argv[2]) : resolve(root, "packages/tfx/src/internal/telegram/generated/TelegramApi.ts"), generated)
