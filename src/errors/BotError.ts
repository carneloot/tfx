/**
 * Base error type for bot errors
 */
export class BotError extends Error {
  constructor(
    readonly name: string,
    message: string
  ) {
    super(message)
    Object.setPrototypeOf(this, BotError.prototype)
  }
}

/**
 * Error thrown when command triggers conflict
 */
export class CommandConflictError extends BotError {
  constructor(
    readonly trigger: string,
    readonly commands: Array<string>
  ) {
    super(
      "CommandConflictError",
      `Duplicate command trigger "${trigger}" defined in commands: ${commands.join(", ")}`
    )
    Object.setPrototypeOf(this, CommandConflictError.prototype)
  }
}

/**
 * Error thrown when a required middleware is missing
 */
export class MissingMiddlewareError extends BotError {
  constructor(readonly middlewareName: string) {
    super(
      "MissingMiddlewareError",
      `Required middleware "${middlewareName}" was not provided`
    )
    Object.setPrototypeOf(this, MissingMiddlewareError.prototype)
  }
}

/**
 * Error thrown when a required command is missing
 */
export class MissingCommandError extends BotError {
  constructor(readonly commandName: string) {
    super(
      "MissingCommandError",
      `Required command "${commandName}" was not provided`
    )
    Object.setPrototypeOf(this, MissingCommandError.prototype)
  }
}
