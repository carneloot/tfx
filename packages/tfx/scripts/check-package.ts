import { execFileSync } from "node:child_process"

const output = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: new URL("..", import.meta.url), encoding: "utf8" })
const [{ files }] = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>
const paths = new Set(files.map(({ path }) => path))
for (const required of [
  "dist/Telegram.js",
  "dist/Telegram.d.ts",
  "dist/TelegramError.js",
  "dist/TelegramError.d.ts",
  "dist/internal/telegram/generated/TelegramApi.runtime.js",
  "dist/internal/telegram/generated/TelegramApi.runtime.d.ts"
]) {
  if (!paths.has(required)) throw new Error(`packed tfx artifact missing ${required}`)
}
