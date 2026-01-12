import type { Update } from "@effect-ak/tg-bot-api"
import type { CommandConfig } from "../Command"

/**
 * Information about a matched command
 */
export interface MatchedCommand {
  readonly config: CommandConfig
  readonly args: string
}

/**
 * Extract command and arguments from a message
 */
export const extractCommand = (
  text: string
): { command: string; args: string } | null => {
  const match = text.match(/^\/(\w+)\s*(.*)/s)
  if (!match) return null

  return {
    command: match[1],
    args: match[2]
  }
}

/**
 * Match an update to a command
 * Returns the matched command with highest specificity
 */
export const matchCommand = (
  update: Update,
  commands: Map<string, Array<CommandConfig>>
): MatchedCommand | null => {
  const text = update.message?.text
  if (!text) return null

  const extracted = extractCommand(text)
  if (!extracted) return null

  const { args, command } = extracted

  // Check exact match first
  const exactMatches = commands.get(command)
  if (exactMatches && exactMatches.length > 0) {
    return {
      config: exactMatches[0],
      args
    }
  }

  // Check if command is an alias
  for (const [_, configs] of commands) {
    for (const config of configs) {
      if (config.aliases.includes(command)) {
        return {
          config,
          args
        }
      }
    }
  }

  return null
}
