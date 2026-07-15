import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "../../..")
const committed = resolve(root, "packages/tfx/src/internal/telegram/generated/TelegramApi.ts")
const directory = mkdtempSync(join(tmpdir(), "tfx-telegram-"))
const candidate = join(directory, "TelegramApi.ts")
try {
  execFileSync("node", [resolve(root, "packages/tfx/scripts/generate-telegram.ts"), candidate], { cwd: root, stdio: "inherit" })
  if (!readFileSync(committed).equals(readFileSync(candidate))) {
    throw new Error("generated TelegramApi.ts differs; run pnpm --filter tfx telegram:generate")
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
