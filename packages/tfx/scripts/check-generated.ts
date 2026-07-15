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
  for (const name of ["TelegramApi.ts", "TelegramApi.types.ts", "TelegramApi.runtime.js", "TelegramApi.runtime.d.ts"]) {
    const expected = resolve(root, "packages/tfx/src/internal/telegram/generated", name)
    const actual = join(directory, name)
    if (!readFileSync(expected).equals(readFileSync(actual))) {
      throw new Error(`${name} differs; run pnpm --filter tfx telegram:generate`)
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
