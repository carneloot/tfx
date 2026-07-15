import { cpSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const source = resolve(root, "src/internal/telegram/generated")
const target = resolve(root, "dist/internal/telegram/generated")
mkdirSync(target, { recursive: true })
for (const file of ["TelegramApi.runtime.js", "TelegramApi.runtime.d.ts"]) cpSync(resolve(source, file), resolve(target, file))
