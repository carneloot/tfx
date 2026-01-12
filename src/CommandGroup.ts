import { Context, Layer } from "effect"
import type { CommandBuilder, CommandLayerBuilder } from "./Command"

/**
 * Represents a group of commands with a common prefix
 */
export interface CommandGroupConfig {
  readonly name: string
  readonly description: string
  readonly commands: ReadonlyArray<CommandBuilder | CommandLayerBuilder>
  readonly subgroups: ReadonlyArray<CommandGroup>
}

/**
 * A CommandGroup organizes related commands under a common prefix
 * e.g., CommandGroup("admin") contains /admin ban, /admin kick, etc
 */
export class CommandGroup extends Context.Tag<CommandGroup>()(
  "CommandGroup",
  {
    name: "",
    description: "",
    commands: [],
    subgroups: []
  }
) {
  /**
   * Create a new command group
   * @param name The group prefix (without /)
   * @param description Description of the group
   */
  static make(name: string, description: string): CommandGroupBuilder {
    return new CommandGroupBuilder({
      name,
      description,
      commands: [],
      subgroups: []
    })
  }

  /**
   * Create a layer that provides this command group
   */
  static makeLayer(group: CommandGroupBuilder): CommandGroupLayerBuilder {
    return new CommandGroupLayerBuilder(group.config)
  }
}

/**
 * Builder for creating command groups
 */
export class CommandGroupBuilder {
  constructor(readonly config: CommandGroupConfig) {}

  /**
   * Add a command to this group
   */
  add(command: CommandBuilder | CommandLayerBuilder): CommandGroupBuilder {
    return new CommandGroupBuilder({
      ...this.config,
      commands: [...this.config.commands, command]
    })
  }

  /**
   * Add a subgroup to this group
   */
  addSubGroup(group: CommandGroupBuilder): CommandGroupBuilder {
    return new CommandGroupBuilder({
      ...this.config,
      subgroups: [...this.config.subgroups, group as any]
    })
  }

  /**
   * Get the configuration
   */
  getConfig(): CommandGroupConfig {
    return this.config
  }
}

/**
 * Builder for creating command group layers
 */
export class CommandGroupLayerBuilder {
  constructor(readonly config: CommandGroupConfig) {}

  /**
   * Build the layer (internal use)
   */
  buildLayer(): Layer.Layer<any> {
    // This will be properly implemented during implementation phase
    return Layer.succeed({} as any, {} as any)
  }
}
