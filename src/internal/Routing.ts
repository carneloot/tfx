import type { Update } from "@effect-ak/tg-bot-api"
import type { CommandDefinition } from "../Command.js"

/**
 * Information about a matched command
 */
export interface MatchedCommand {
  readonly command: CommandDefinition
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
  commands: Map<string, CommandDefinition>
): MatchedCommand | null => {
  const text = update.message?.text
  if (!text) return null

  const extracted = extractCommand(text)
  if (!extracted) return null

  const { args, command } = extracted

  // Check exact match first
  const matched = commands.get(command)
  if (matched) {
    return {
      command: matched,
      args
    }
  }

  return null
}
