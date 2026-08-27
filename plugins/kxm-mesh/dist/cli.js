#!/usr/bin/env node

// plugins/kxm-mesh/src/cli.ts
import { spawn } from "node:child_process";
import { createHmac as createHmac2, randomUUID as randomUUID2 } from "node:crypto";
import { cpSync, existsSync as existsSync3, mkdirSync as mkdirSync5, readFileSync as readFileSync4, readdirSync as readdirSync2, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join9, resolve as resolve3 } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// node_modules/commander/lib/error.js
var CommanderError = class extends Error {
  /**
   * Constructs the CommanderError class
   * @param {number} exitCode suggested exit code which could be used with process.exit
   * @param {string} code an id string representing the error
   * @param {string} message human-readable description of the error
   */
  constructor(exitCode, code, message) {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.name = this.constructor.name;
    this.code = code;
    this.exitCode = exitCode;
    this.nestedError = void 0;
  }
};
var InvalidArgumentError = class extends CommanderError {
  /**
   * Constructs the InvalidArgumentError class
   * @param {string} [message] explanation of why argument is invalid
   */
  constructor(message) {
    super(1, "commander.invalidArgument", message);
    Error.captureStackTrace(this, this.constructor);
    this.name = this.constructor.name;
  }
};

// node_modules/commander/lib/argument.js
var Argument = class {
  /**
   * Initialize a new command argument with the given name and description.
   * The default is that the argument is required, and you can explicitly
   * indicate this with <> around the name. Put [] around the name for an optional argument.
   *
   * @param {string} name
   * @param {string} [description]
   */
  constructor(name, description) {
    this.description = description || "";
    this.variadic = false;
    this.parseArg = void 0;
    this.defaultValue = void 0;
    this.defaultValueDescription = void 0;
    this.argChoices = void 0;
    switch (name[0]) {
      case "<":
        this.required = true;
        this._name = name.slice(1, -1);
        break;
      case "[":
        this.required = false;
        this._name = name.slice(1, -1);
        break;
      default:
        this.required = true;
        this._name = name;
        break;
    }
    if (this._name.endsWith("...")) {
      this.variadic = true;
      this._name = this._name.slice(0, -3);
    }
  }
  /**
   * Return argument name.
   *
   * @return {string}
   */
  name() {
    return this._name;
  }
  /**
   * @package
   */
  _collectValue(value, previous) {
    if (previous === this.defaultValue || !Array.isArray(previous)) {
      return [value];
    }
    previous.push(value);
    return previous;
  }
  /**
   * Set the default value, and optionally supply the description to be displayed in the help.
   *
   * @param {*} value
   * @param {string} [description]
   * @return {Argument}
   */
  default(value, description) {
    this.defaultValue = value;
    this.defaultValueDescription = description;
    return this;
  }
  /**
   * Set the custom handler for processing CLI command arguments into argument values.
   *
   * @param {Function} [fn]
   * @return {Argument}
   */
  argParser(fn) {
    this.parseArg = fn;
    return this;
  }
  /**
   * Only allow argument value to be one of choices.
   *
   * @param {string[]} values
   * @return {Argument}
   */
  choices(values) {
    this.argChoices = values.slice();
    this.parseArg = (arg, previous) => {
      if (!this.argChoices.includes(arg)) {
        throw new InvalidArgumentError(
          `Allowed choices are ${this.argChoices.join(", ")}.`
        );
      }
      if (this.variadic) {
        return this._collectValue(arg, previous);
      }
      return arg;
    };
    return this;
  }
  /**
   * Make argument required.
   *
   * @returns {Argument}
   */
  argRequired() {
    this.required = true;
    return this;
  }
  /**
   * Make argument optional.
   *
   * @returns {Argument}
   */
  argOptional() {
    this.required = false;
    return this;
  }
};
function humanReadableArgName(arg) {
  const nameOutput = arg.name() + (arg.variadic === true ? "..." : "");
  return arg.required ? "<" + nameOutput + ">" : "[" + nameOutput + "]";
}

// node_modules/commander/lib/command.js
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import process2 from "node:process";
import { stripVTControlCharacters as stripVTControlCharacters2 } from "node:util";

// node_modules/commander/lib/help.js
import { stripVTControlCharacters } from "node:util";
var Help = class {
  constructor() {
    this.helpWidth = void 0;
    this.minWidthToWrap = 40;
    this.sortSubcommands = false;
    this.sortOptions = false;
    this.showGlobalOptions = false;
  }
  /**
   * prepareContext is called by Commander after applying overrides from `Command.configureHelp()`
   * and just before calling `formatHelp()`.
   *
   * Commander just uses the helpWidth and the rest is provided for optional use by more complex subclasses.
   *
   * @param {{ error?: boolean, helpWidth?: number, outputHasColors?: boolean }} contextOptions
   */
  prepareContext(contextOptions) {
    this.helpWidth = this.helpWidth ?? contextOptions.helpWidth ?? 80;
  }
  /**
   * Get an array of the visible subcommands. Includes a placeholder for the implicit help command, if there is one.
   *
   * @param {Command} cmd
   * @returns {Command[]}
   */
  visibleCommands(cmd) {
    const visibleCommands = cmd.commands.filter((cmd2) => !cmd2._hidden);
    const helpCommand = cmd._getHelpCommand();
    if (helpCommand && !helpCommand._hidden) {
      visibleCommands.push(helpCommand);
    }
    if (this.sortSubcommands) {
      visibleCommands.sort((a, b2) => {
        return a.name().localeCompare(b2.name());
      });
    }
    return visibleCommands;
  }
  /**
   * Compare options for sort.
   *
   * @param {Option} a
   * @param {Option} b
   * @returns {number}
   */
  compareOptions(a, b2) {
    const getSortKey = (option) => {
      return option.short ? option.short.replace(/^-/, "") : option.long.replace(/^--/, "");
    };
    return getSortKey(a).localeCompare(getSortKey(b2));
  }
  /**
   * Get an array of the visible options. Includes a placeholder for the implicit help option, if there is one.
   *
   * @param {Command} cmd
   * @returns {Option[]}
   */
  visibleOptions(cmd) {
    const visibleOptions = cmd.options.filter((option) => !option.hidden);
    const helpOption = cmd._getHelpOption();
    if (helpOption && !helpOption.hidden) {
      const removeShort = helpOption.short && cmd._findOption(helpOption.short);
      const removeLong = helpOption.long && cmd._findOption(helpOption.long);
      if (!removeShort && !removeLong) {
        visibleOptions.push(helpOption);
      } else if (helpOption.long && !removeLong) {
        visibleOptions.push(
          cmd.createOption(helpOption.long, helpOption.description)
        );
      } else if (helpOption.short && !removeShort) {
        visibleOptions.push(
          cmd.createOption(helpOption.short, helpOption.description)
        );
      }
    }
    if (this.sortOptions) {
      visibleOptions.sort(this.compareOptions);
    }
    return visibleOptions;
  }
  /**
   * Get an array of the visible global options. (Not including help.)
   *
   * @param {Command} cmd
   * @returns {Option[]}
   */
  visibleGlobalOptions(cmd) {
    if (!this.showGlobalOptions) return [];
    const globalOptions = [];
    for (let ancestorCmd = cmd.parent; ancestorCmd; ancestorCmd = ancestorCmd.parent) {
      const visibleOptions = ancestorCmd.options.filter(
        (option) => !option.hidden
      );
      globalOptions.push(...visibleOptions);
    }
    if (this.sortOptions) {
      globalOptions.sort(this.compareOptions);
    }
    return globalOptions;
  }
  /**
   * Get an array of the arguments if any have a description.
   *
   * @param {Command} cmd
   * @returns {Argument[]}
   */
  visibleArguments(cmd) {
    if (cmd._argsDescription) {
      cmd.registeredArguments.forEach((argument) => {
        argument.description = argument.description || cmd._argsDescription[argument.name()] || "";
      });
    }
    if (cmd.registeredArguments.find((argument) => argument.description)) {
      return cmd.registeredArguments;
    }
    return [];
  }
  /**
   * Get the command term to show in the list of subcommands.
   *
   * @param {Command} cmd
   * @returns {string}
   */
  subcommandTerm(cmd) {
    const args = cmd.registeredArguments.map((arg) => humanReadableArgName(arg)).join(" ");
    return cmd._name + (cmd._aliases[0] ? "|" + cmd._aliases[0] : "") + (cmd.options.length ? " [options]" : "") + // simplistic check for non-help option
    (args ? " " + args : "");
  }
  /**
   * Get the option term to show in the list of options.
   *
   * @param {Option} option
   * @returns {string}
   */
  optionTerm(option) {
    return option.flags;
  }
  /**
   * Get the argument term to show in the list of arguments.
   *
   * @param {Argument} argument
   * @returns {string}
   */
  argumentTerm(argument) {
    return argument.name();
  }
  /**
   * Get the longest command term length.
   *
   * @param {Command} cmd
   * @param {Help} helper
   * @returns {number}
   */
  longestSubcommandTermLength(cmd, helper) {
    return helper.visibleCommands(cmd).reduce((max, command) => {
      return Math.max(
        max,
        this.displayWidth(
          helper.styleSubcommandTerm(helper.subcommandTerm(command))
        )
      );
    }, 0);
  }
  /**
   * Get the longest option term length.
   *
   * @param {Command} cmd
   * @param {Help} helper
   * @returns {number}
   */
  longestOptionTermLength(cmd, helper) {
    return helper.visibleOptions(cmd).reduce((max, option) => {
      return Math.max(
        max,
        this.displayWidth(helper.styleOptionTerm(helper.optionTerm(option)))
      );
    }, 0);
  }
  /**
   * Get the longest global option term length.
   *
   * @param {Command} cmd
   * @param {Help} helper
   * @returns {number}
   */
  longestGlobalOptionTermLength(cmd, helper) {
    return helper.visibleGlobalOptions(cmd).reduce((max, option) => {
      return Math.max(
        max,
        this.displayWidth(helper.styleOptionTerm(helper.optionTerm(option)))
      );
    }, 0);
  }
  /**
   * Get the longest argument term length.
   *
   * @param {Command} cmd
   * @param {Help} helper
   * @returns {number}
   */
  longestArgumentTermLength(cmd, helper) {
    return helper.visibleArguments(cmd).reduce((max, argument) => {
      return Math.max(
        max,
        this.displayWidth(
          helper.styleArgumentTerm(helper.argumentTerm(argument))
        )
      );
    }, 0);
  }
  /**
   * Get the command usage to be displayed at the top of the built-in help.
   *
   * @param {Command} cmd
   * @returns {string}
   */
  commandUsage(cmd) {
    let cmdName = cmd._name;
    if (cmd._aliases[0]) {
      cmdName = cmdName + "|" + cmd._aliases[0];
    }
    let ancestorCmdNames = "";
    for (let ancestorCmd = cmd.parent; ancestorCmd; ancestorCmd = ancestorCmd.parent) {
      ancestorCmdNames = ancestorCmd.name() + " " + ancestorCmdNames;
    }
    return ancestorCmdNames + cmdName + " " + cmd.usage();
  }
  /**
   * Get the description for the command.
   *
   * @param {Command} cmd
   * @returns {string}
   */
  commandDescription(cmd) {
    return cmd.description();
  }
  /**
   * Get the subcommand summary to show in the list of subcommands.
   * (Fallback to description for backwards compatibility.)
   *
   * @param {Command} cmd
   * @returns {string}
   */
  subcommandDescription(cmd) {
    return cmd.summary() || cmd.description();
  }
  /**
   * Get the option description to show in the list of options.
   *
   * @param {Option} option
   * @return {string}
   */
  optionDescription(option) {
    const extraInfo = [];
    if (option.argChoices) {
      extraInfo.push(
        // use stringify to match the display of the default value
        `choices: ${option.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`
      );
    }
    if (option.defaultValue !== void 0) {
      const showDefault = option.required || option.optional || option.isBoolean() && typeof option.defaultValue === "boolean";
      if (showDefault) {
        extraInfo.push(
          `default: ${option.defaultValueDescription || JSON.stringify(option.defaultValue)}`
        );
      }
    }
    if (option.presetArg !== void 0 && option.optional) {
      extraInfo.push(`preset: ${JSON.stringify(option.presetArg)}`);
    }
    if (option.envVar !== void 0) {
      extraInfo.push(`env: ${option.envVar}`);
    }
    if (extraInfo.length > 0) {
      const extraDescription = `(${extraInfo.join(", ")})`;
      if (option.description) {
        return `${option.description} ${extraDescription}`;
      }
      return extraDescription;
    }
    return option.description;
  }
  /**
   * Get the argument description to show in the list of arguments.
   *
   * @param {Argument} argument
   * @return {string}
   */
  argumentDescription(argument) {
    const extraInfo = [];
    if (argument.argChoices) {
      extraInfo.push(
        // use stringify to match the display of the default value
        `choices: ${argument.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`
      );
    }
    if (argument.defaultValue !== void 0) {
      extraInfo.push(
        `default: ${argument.defaultValueDescription || JSON.stringify(argument.defaultValue)}`
      );
    }
    if (extraInfo.length > 0) {
      const extraDescription = `(${extraInfo.join(", ")})`;
      if (argument.description) {
        return `${argument.description} ${extraDescription}`;
      }
      return extraDescription;
    }
    return argument.description;
  }
  /**
   * Format a list of items, given a heading and an array of formatted items.
   *
   * @param {string} heading
   * @param {string[]} items
   * @param {Help} helper
   * @returns string[]
   */
  formatItemList(heading, items, helper) {
    if (items.length === 0) return [];
    return [helper.styleTitle(heading), ...items, ""];
  }
  /**
   * Group items by their help group heading.
   *
   * @param {Command[] | Option[]} unsortedItems
   * @param {Command[] | Option[]} visibleItems
   * @param {Function} getGroup
   * @returns {Map<string, Command[] | Option[]>}
   */
  groupItems(unsortedItems, visibleItems, getGroup) {
    const result = /* @__PURE__ */ new Map();
    unsortedItems.forEach((item) => {
      const group = getGroup(item);
      if (!result.has(group)) result.set(group, []);
    });
    visibleItems.forEach((item) => {
      const group = getGroup(item);
      if (!result.has(group)) {
        result.set(group, []);
      }
      result.get(group).push(item);
    });
    return result;
  }
  /**
   * Generate the built-in help text.
   *
   * @param {Command} cmd
   * @param {Help} helper
   * @returns {string}
   */
  formatHelp(cmd, helper) {
    const termWidth = helper.padWidth(cmd, helper);
    const helpWidth = helper.helpWidth ?? 80;
    function callFormatItem(term, description) {
      return helper.formatItem(term, termWidth, description, helper);
    }
    let output = [
      `${helper.styleTitle("Usage:")} ${helper.styleUsage(helper.commandUsage(cmd))}`,
      ""
    ];
    const commandDescription = helper.commandDescription(cmd);
    if (commandDescription.length > 0) {
      output = output.concat([
        helper.boxWrap(
          helper.styleCommandDescription(commandDescription),
          helpWidth
        ),
        ""
      ]);
    }
    const argumentList = helper.visibleArguments(cmd).map((argument) => {
      return callFormatItem(
        helper.styleArgumentTerm(helper.argumentTerm(argument)),
        helper.styleArgumentDescription(helper.argumentDescription(argument))
      );
    });
    output = output.concat(
      this.formatItemList("Arguments:", argumentList, helper)
    );
    const optionGroups = this.groupItems(
      cmd.options,
      helper.visibleOptions(cmd),
      (option) => option.helpGroupHeading ?? "Options:"
    );
    optionGroups.forEach((options, group) => {
      const optionList = options.map((option) => {
        return callFormatItem(
          helper.styleOptionTerm(helper.optionTerm(option)),
          helper.styleOptionDescription(helper.optionDescription(option))
        );
      });
      output = output.concat(this.formatItemList(group, optionList, helper));
    });
    if (helper.showGlobalOptions) {
      const globalOptionList = helper.visibleGlobalOptions(cmd).map((option) => {
        return callFormatItem(
          helper.styleOptionTerm(helper.optionTerm(option)),
          helper.styleOptionDescription(helper.optionDescription(option))
        );
      });
      output = output.concat(
        this.formatItemList("Global Options:", globalOptionList, helper)
      );
    }
    const commandGroups = this.groupItems(
      cmd.commands,
      helper.visibleCommands(cmd),
      (sub) => sub.helpGroup() || "Commands:"
    );
    commandGroups.forEach((commands, group) => {
      const commandList = commands.map((sub) => {
        return callFormatItem(
          helper.styleSubcommandTerm(helper.subcommandTerm(sub)),
          helper.styleSubcommandDescription(helper.subcommandDescription(sub))
        );
      });
      output = output.concat(this.formatItemList(group, commandList, helper));
    });
    return output.join("\n");
  }
  /**
   * Return display width of string, ignoring ANSI escape sequences. Used in padding and wrapping calculations.
   *
   * @param {string} str
   * @returns {number}
   */
  displayWidth(str) {
    return stripVTControlCharacters(str).length;
  }
  /**
   * Style the title for displaying in the help. Called with 'Usage:', 'Options:', etc.
   *
   * @param {string} str
   * @returns {string}
   */
  styleTitle(str) {
    return str;
  }
  styleUsage(str) {
    return str.split(" ").map((word) => {
      if (word === "[options]") return this.styleOptionText(word);
      if (word === "[command]") return this.styleSubcommandText(word);
      if (word[0] === "[" || word[0] === "<")
        return this.styleArgumentText(word);
      return this.styleCommandText(word);
    }).join(" ");
  }
  styleCommandDescription(str) {
    return this.styleDescriptionText(str);
  }
  styleOptionDescription(str) {
    return this.styleDescriptionText(str);
  }
  styleSubcommandDescription(str) {
    return this.styleDescriptionText(str);
  }
  styleArgumentDescription(str) {
    return this.styleDescriptionText(str);
  }
  styleDescriptionText(str) {
    return str;
  }
  styleOptionTerm(str) {
    return this.styleOptionText(str);
  }
  styleSubcommandTerm(str) {
    return str.split(" ").map((word) => {
      if (word === "[options]") return this.styleOptionText(word);
      if (word[0] === "[" || word[0] === "<")
        return this.styleArgumentText(word);
      return this.styleSubcommandText(word);
    }).join(" ");
  }
  styleArgumentTerm(str) {
    return this.styleArgumentText(str);
  }
  styleOptionText(str) {
    return str;
  }
  styleArgumentText(str) {
    return str;
  }
  styleSubcommandText(str) {
    return str;
  }
  styleCommandText(str) {
    return str;
  }
  /**
   * Calculate the pad width from the maximum term length.
   *
   * @param {Command} cmd
   * @param {Help} helper
   * @returns {number}
   */
  padWidth(cmd, helper) {
    return Math.max(
      helper.longestOptionTermLength(cmd, helper),
      helper.longestGlobalOptionTermLength(cmd, helper),
      helper.longestSubcommandTermLength(cmd, helper),
      helper.longestArgumentTermLength(cmd, helper)
    );
  }
  /**
   * Detect manually wrapped and indented strings by checking for line break followed by whitespace.
   *
   * @param {string} str
   * @returns {boolean}
   */
  preformatted(str) {
    return /\n[^\S\r\n]/.test(str);
  }
  /**
   * Format the "item", which consists of a term and description. Pad the term and wrap the description, indenting the following lines.
   *
   * So "TTT", 5, "DDD DDDD DD DDD" might be formatted for this.helpWidth=17 like so:
   *   TTT  DDD DDDD
   *        DD DDD
   *
   * @param {string} term
   * @param {number} termWidth
   * @param {string} description
   * @param {Help} helper
   * @returns {string}
   */
  formatItem(term, termWidth, description, helper) {
    const itemIndent = 2;
    const itemIndentStr = " ".repeat(itemIndent);
    if (!description) return itemIndentStr + term;
    const paddedTerm = term.padEnd(
      termWidth + term.length - helper.displayWidth(term)
    );
    const spacerWidth = 2;
    const helpWidth = this.helpWidth ?? 80;
    const remainingWidth = helpWidth - termWidth - spacerWidth - itemIndent;
    let formattedDescription;
    if (remainingWidth < this.minWidthToWrap || helper.preformatted(description)) {
      formattedDescription = description;
    } else {
      const wrappedDescription = helper.boxWrap(description, remainingWidth);
      formattedDescription = wrappedDescription.replace(
        /\n/g,
        "\n" + " ".repeat(termWidth + spacerWidth)
      );
    }
    return itemIndentStr + paddedTerm + " ".repeat(spacerWidth) + formattedDescription.replace(/\n/g, `
${itemIndentStr}`);
  }
  /**
   * Wrap a string at whitespace, preserving existing line breaks.
   * Wrapping is skipped if the width is less than `minWidthToWrap`.
   *
   * @param {string} str
   * @param {number} width
   * @returns {string}
   */
  boxWrap(str, width) {
    if (width < this.minWidthToWrap) return str;
    const rawLines = str.split(/\r\n|\n/);
    const chunkPattern = /[\s]*[^\s]+/g;
    const wrappedLines = [];
    rawLines.forEach((line) => {
      const chunks = line.match(chunkPattern);
      if (chunks === null) {
        wrappedLines.push("");
        return;
      }
      let sumChunks = [chunks.shift()];
      let sumWidth = this.displayWidth(sumChunks[0]);
      chunks.forEach((chunk) => {
        const visibleWidth2 = this.displayWidth(chunk);
        if (sumWidth + visibleWidth2 <= width) {
          sumChunks.push(chunk);
          sumWidth += visibleWidth2;
          return;
        }
        wrappedLines.push(sumChunks.join(""));
        const nextChunk = chunk.trimStart();
        sumChunks = [nextChunk];
        sumWidth = this.displayWidth(nextChunk);
      });
      wrappedLines.push(sumChunks.join(""));
    });
    return wrappedLines.join("\n");
  }
};

// node_modules/commander/lib/option.js
var Option = class {
  /**
   * Initialize a new `Option` with the given `flags` and `description`.
   *
   * @param {string} flags
   * @param {string} [description]
   */
  constructor(flags, description) {
    this.flags = flags;
    this.description = description || "";
    this.required = flags.includes("<");
    this.optional = flags.includes("[");
    this.variadic = /\w\.\.\.[>\]]$/.test(flags);
    this.mandatory = false;
    const optionFlags = splitOptionFlags(flags);
    this.short = optionFlags.shortFlag;
    this.long = optionFlags.longFlag;
    this.negate = false;
    if (this.long) {
      this.negate = this.long.startsWith("--no-");
    }
    this.defaultValue = void 0;
    this.defaultValueDescription = void 0;
    this.presetArg = void 0;
    this.envVar = void 0;
    this.parseArg = void 0;
    this.hidden = false;
    this.argChoices = void 0;
    this.conflictsWith = [];
    this.implied = void 0;
    this.helpGroupHeading = void 0;
  }
  /**
   * Set the default value, and optionally supply the description to be displayed in the help.
   *
   * @param {*} value
   * @param {string} [description]
   * @return {Option}
   */
  default(value, description) {
    this.defaultValue = value;
    this.defaultValueDescription = description;
    return this;
  }
  /**
   * Preset to use when option used without option-argument, especially optional but also boolean and negated.
   * The custom processing (parseArg) is called.
   *
   * @example
   * new Option('--color').default('GREYSCALE').preset('RGB');
   * new Option('--donate [amount]').preset('20').argParser(parseFloat);
   *
   * @param {*} arg
   * @return {Option}
   */
  preset(arg) {
    this.presetArg = arg;
    return this;
  }
  /**
   * Add option name(s) that conflict with this option.
   * An error will be displayed if conflicting options are found during parsing.
   *
   * @example
   * new Option('--rgb').conflicts('cmyk');
   * new Option('--js').conflicts(['ts', 'jsx']);
   *
   * @param {(string | string[])} names
   * @return {Option}
   */
  conflicts(names) {
    this.conflictsWith = this.conflictsWith.concat(names);
    return this;
  }
  /**
   * Specify implied option values for when this option is set and the implied options are not.
   *
   * The custom processing (parseArg) is not called on the implied values.
   *
   * @example
   * program
   *   .addOption(new Option('--log', 'write logging information to file'))
   *   .addOption(new Option('--trace', 'log extra details').implies({ log: 'trace.txt' }));
   *
   * @param {object} impliedOptionValues
   * @return {Option}
   */
  implies(impliedOptionValues) {
    let newImplied = impliedOptionValues;
    if (typeof impliedOptionValues === "string") {
      newImplied = { [impliedOptionValues]: true };
    }
    this.implied = Object.assign(this.implied || {}, newImplied);
    return this;
  }
  /**
   * Set environment variable to check for option value.
   *
   * An environment variable is only used if when processed the current option value is
   * undefined, or the source of the current value is 'default' or 'config' or 'env'.
   *
   * @param {string} name
   * @return {Option}
   */
  env(name) {
    this.envVar = name;
    return this;
  }
  /**
   * Set the custom handler for processing CLI option arguments into option values.
   *
   * @param {Function} [fn]
   * @return {Option}
   */
  argParser(fn) {
    this.parseArg = fn;
    return this;
  }
  /**
   * Whether the option is mandatory and must have a value after parsing.
   *
   * @param {boolean} [mandatory=true]
   * @return {Option}
   */
  makeOptionMandatory(mandatory = true) {
    this.mandatory = !!mandatory;
    return this;
  }
  /**
   * Hide option in help.
   *
   * @param {boolean} [hide=true]
   * @return {Option}
   */
  hideHelp(hide = true) {
    this.hidden = !!hide;
    return this;
  }
  /**
   * @package
   */
  _collectValue(value, previous) {
    if (previous === this.defaultValue || !Array.isArray(previous)) {
      return [value];
    }
    previous.push(value);
    return previous;
  }
  /**
   * Only allow option value to be one of choices.
   *
   * @param {string[]} values
   * @return {Option}
   */
  choices(values) {
    this.argChoices = values.slice();
    this.parseArg = (arg, previous) => {
      if (!this.argChoices.includes(arg)) {
        throw new InvalidArgumentError(
          `Allowed choices are ${this.argChoices.join(", ")}.`
        );
      }
      if (this.variadic) {
        return this._collectValue(arg, previous);
      }
      return arg;
    };
    return this;
  }
  /**
   * Return option name.
   *
   * @return {string}
   */
  name() {
    if (this.long) {
      return this.long.replace(/^--/, "");
    }
    return this.short.replace(/^-/, "");
  }
  /**
   * Return option name, in a camelcase format that can be used
   * as an object attribute key.
   *
   * @return {string}
   */
  attributeName() {
    if (this.negate) {
      return camelcase(this.name().replace(/^no-/, ""));
    }
    return camelcase(this.name());
  }
  /**
   * Set the help group heading.
   *
   * @param {string} heading
   * @return {Option}
   */
  helpGroup(heading) {
    this.helpGroupHeading = heading;
    return this;
  }
  /**
   * Check if `arg` matches the short or long flag.
   *
   * @param {string} arg
   * @return {boolean}
   * @package
   */
  is(arg) {
    return this.short === arg || this.long === arg;
  }
  /**
   * Return whether a boolean option.
   *
   * Options are one of boolean, negated, required argument, or optional argument.
   *
   * @return {boolean}
   * @package
   */
  isBoolean() {
    return !this.required && !this.optional && !this.negate;
  }
};
var DualOptions = class {
  /**
   * @param {Option[]} options
   */
  constructor(options) {
    this.positiveOptions = /* @__PURE__ */ new Map();
    this.negativeOptions = /* @__PURE__ */ new Map();
    this.dualOptions = /* @__PURE__ */ new Set();
    options.forEach((option) => {
      if (option.negate) {
        this.negativeOptions.set(option.attributeName(), option);
      } else {
        this.positiveOptions.set(option.attributeName(), option);
      }
    });
    this.negativeOptions.forEach((value, key) => {
      if (this.positiveOptions.has(key)) {
        this.dualOptions.add(key);
      }
    });
  }
  /**
   * Did the value come from the option, and not from possible matching dual option?
   *
   * @param {*} value
   * @param {Option} option
   * @returns {boolean}
   */
  valueFromOption(value, option) {
    const optionKey = option.attributeName();
    if (!this.dualOptions.has(optionKey)) return true;
    const preset = this.negativeOptions.get(optionKey).presetArg;
    const negativeValue = preset !== void 0 ? preset : false;
    return option.negate === (negativeValue === value);
  }
};
function camelcase(str) {
  return str.split("-").reduce((str2, word) => {
    return str2 + word[0].toUpperCase() + word.slice(1);
  });
}
function splitOptionFlags(flags) {
  let shortFlag;
  let longFlag;
  const shortFlagExp = /^-[^-]$/;
  const longFlagExp = /^--[^-]/;
  const flagParts = flags.split(/[ |,]+/).concat("guard");
  if (shortFlagExp.test(flagParts[0])) shortFlag = flagParts.shift();
  if (longFlagExp.test(flagParts[0])) longFlag = flagParts.shift();
  if (!shortFlag && shortFlagExp.test(flagParts[0]))
    shortFlag = flagParts.shift();
  if (!shortFlag && longFlagExp.test(flagParts[0])) {
    shortFlag = longFlag;
    longFlag = flagParts.shift();
  }
  if (flagParts[0].startsWith("-")) {
    const unsupportedFlag = flagParts[0];
    const baseError = `option creation failed due to '${unsupportedFlag}' in option flags '${flags}'`;
    if (/^-[^-][^-]/.test(unsupportedFlag))
      throw new Error(
        `${baseError}
- a short flag is a single dash and a single character
  - either use a single dash and a single character (for a short flag)
  - or use a double dash for a long option (and can have two, like '--ws, --workspace')`
      );
    if (shortFlagExp.test(unsupportedFlag))
      throw new Error(`${baseError}
- too many short flags`);
    if (longFlagExp.test(unsupportedFlag))
      throw new Error(`${baseError}
- too many long flags`);
    throw new Error(`${baseError}
- unrecognised flag format`);
  }
  if (shortFlag === void 0 && longFlag === void 0)
    throw new Error(
      `option creation failed due to no flags found in '${flags}'.`
    );
  return { shortFlag, longFlag };
}

// node_modules/commander/lib/suggestSimilar.js
var maxDistance = 3;
function editDistance(a, b2) {
  if (Math.abs(a.length - b2.length) > maxDistance)
    return Math.max(a.length, b2.length);
  const d2 = [];
  for (let i = 0; i <= a.length; i++) {
    d2[i] = [i];
  }
  for (let j2 = 0; j2 <= b2.length; j2++) {
    d2[0][j2] = j2;
  }
  for (let j2 = 1; j2 <= b2.length; j2++) {
    for (let i = 1; i <= a.length; i++) {
      let cost;
      if (a[i - 1] === b2[j2 - 1]) {
        cost = 0;
      } else {
        cost = 1;
      }
      d2[i][j2] = Math.min(
        d2[i - 1][j2] + 1,
        // deletion
        d2[i][j2 - 1] + 1,
        // insertion
        d2[i - 1][j2 - 1] + cost
        // substitution
      );
      if (i > 1 && j2 > 1 && a[i - 1] === b2[j2 - 2] && a[i - 2] === b2[j2 - 1]) {
        d2[i][j2] = Math.min(d2[i][j2], d2[i - 2][j2 - 2] + 1);
      }
    }
  }
  return d2[a.length][b2.length];
}
function suggestSimilar(word, candidates) {
  if (!candidates || candidates.length === 0) return "";
  candidates = Array.from(new Set(candidates));
  const searchingOptions = word.startsWith("--");
  if (searchingOptions) {
    word = word.slice(2);
    candidates = candidates.map((candidate) => candidate.slice(2));
  }
  let similar = [];
  let bestDistance = maxDistance;
  const minSimilarity = 0.4;
  candidates.forEach((candidate) => {
    if (candidate.length <= 1) return;
    const distance = editDistance(word, candidate);
    const length = Math.max(word.length, candidate.length);
    const similarity = (length - distance) / length;
    if (similarity > minSimilarity) {
      if (distance < bestDistance) {
        bestDistance = distance;
        similar = [candidate];
      } else if (distance === bestDistance) {
        similar.push(candidate);
      }
    }
  });
  similar.sort((a, b2) => a.localeCompare(b2));
  if (searchingOptions) {
    similar = similar.map((candidate) => `--${candidate}`);
  }
  if (similar.length > 1) {
    return `
(Did you mean one of ${similar.join(", ")}?)`;
  }
  if (similar.length === 1) {
    return `
(Did you mean ${similar[0]}?)`;
  }
  return "";
}

// node_modules/commander/lib/command.js
var Command = class _Command extends EventEmitter {
  /**
   * Initialize a new `Command`.
   *
   * @param {string} [name]
   */
  constructor(name) {
    super();
    this.commands = [];
    this.options = [];
    this.parent = null;
    this._allowUnknownOption = false;
    this._allowExcessArguments = false;
    this.registeredArguments = [];
    this._args = this.registeredArguments;
    this.args = [];
    this.rawArgs = [];
    this.processedArgs = [];
    this._scriptPath = null;
    this._name = name || "";
    this._optionValues = {};
    this._optionValueSources = {};
    this._storeOptionsAsProperties = false;
    this._actionHandler = null;
    this._executableHandler = false;
    this._executableFile = null;
    this._executableDir = null;
    this._defaultCommandName = null;
    this._exitCallback = null;
    this._aliases = [];
    this._combineFlagAndOptionalValue = true;
    this._description = "";
    this._summary = "";
    this._argsDescription = void 0;
    this._enablePositionalOptions = false;
    this._passThroughOptions = false;
    this._lifeCycleHooks = {};
    this._showHelpAfterError = false;
    this._showSuggestionAfterError = true;
    this._savedState = null;
    this._outputConfiguration = {
      writeOut: (str) => process2.stdout.write(str),
      writeErr: (str) => process2.stderr.write(str),
      outputError: (str, write) => write(str),
      getOutHelpWidth: () => process2.stdout.isTTY ? process2.stdout.columns : void 0,
      getErrHelpWidth: () => process2.stderr.isTTY ? process2.stderr.columns : void 0,
      getOutHasColors: () => useColor() ?? (process2.stdout.isTTY && process2.stdout.hasColors?.()),
      getErrHasColors: () => useColor() ?? (process2.stderr.isTTY && process2.stderr.hasColors?.()),
      stripColor: (str) => stripVTControlCharacters2(str)
    };
    this._hidden = false;
    this._helpOption = void 0;
    this._addImplicitHelpCommand = void 0;
    this._helpCommand = void 0;
    this._helpConfiguration = {};
    this._helpGroupHeading = void 0;
    this._defaultCommandGroup = void 0;
    this._defaultOptionGroup = void 0;
  }
  /**
   * Copy settings that are useful to have in common across root command and subcommands.
   *
   * (Used internally when adding a command using `.command()` so subcommands inherit parent settings.)
   *
   * @param {Command} sourceCommand
   * @return {Command} `this` command for chaining
   */
  copyInheritedSettings(sourceCommand) {
    this._outputConfiguration = sourceCommand._outputConfiguration;
    this._helpOption = sourceCommand._helpOption;
    this._helpCommand = sourceCommand._helpCommand;
    this._helpConfiguration = sourceCommand._helpConfiguration;
    this._exitCallback = sourceCommand._exitCallback;
    this._storeOptionsAsProperties = sourceCommand._storeOptionsAsProperties;
    this._combineFlagAndOptionalValue = sourceCommand._combineFlagAndOptionalValue;
    this._allowExcessArguments = sourceCommand._allowExcessArguments;
    this._enablePositionalOptions = sourceCommand._enablePositionalOptions;
    this._showHelpAfterError = sourceCommand._showHelpAfterError;
    this._showSuggestionAfterError = sourceCommand._showSuggestionAfterError;
    return this;
  }
  /**
   * @returns {Command[]}
   * @private
   */
  _getCommandAndAncestors() {
    const result = [];
    for (let command = this; command; command = command.parent) {
      result.push(command);
    }
    return result;
  }
  /**
   * Define a command.
   *
   * There are two styles of command: pay attention to where to put the description.
   *
   * @example
   * // Command implemented using action handler (description is supplied separately to `.command`)
   * program
   *   .command('clone <source> [destination]')
   *   .description('clone a repository into a newly created directory')
   *   .action((source, destination) => {
   *     console.log('clone command called');
   *   });
   *
   * // Command implemented using separate executable file (description is second parameter to `.command`)
   * program
   *   .command('start <service>', 'start named service')
   *   .command('stop [service]', 'stop named service, or all if no name supplied');
   *
   * @param {string} nameAndArgs - command name and arguments, args are `<required>` or `[optional]` and last may also be `variadic...`
   * @param {(object | string)} [actionOptsOrExecDesc] - configuration options (for action), or description (for executable)
   * @param {object} [execOpts] - configuration options (for executable)
   * @return {Command} returns new command for action handler, or `this` for executable command
   */
  command(nameAndArgs, actionOptsOrExecDesc, execOpts) {
    let desc = actionOptsOrExecDesc;
    let opts = execOpts;
    if (typeof desc === "object" && desc !== null) {
      opts = desc;
      desc = null;
    }
    opts = opts || {};
    const [, name, args] = nameAndArgs.match(/([^ ]+) *(.*)/);
    const cmd = this.createCommand(name);
    if (desc) {
      cmd.description(desc);
      cmd._executableHandler = true;
    }
    if (opts.isDefault) this._defaultCommandName = cmd._name;
    cmd._hidden = !!(opts.noHelp || opts.hidden);
    cmd._executableFile = opts.executableFile || null;
    if (args) cmd.arguments(args);
    this._registerCommand(cmd);
    cmd.parent = this;
    cmd.copyInheritedSettings(this);
    if (desc) return this;
    return cmd;
  }
  /**
   * Factory routine to create a new unattached command.
   *
   * See .command() for creating an attached subcommand, which uses this routine to
   * create the command. You can override createCommand to customise subcommands.
   *
   * @param {string} [name]
   * @return {Command} new command
   */
  createCommand(name) {
    return new _Command(name);
  }
  /**
   * You can customise the help with a subclass of Help by overriding createHelp,
   * or by overriding Help properties using configureHelp().
   *
   * @return {Help}
   */
  createHelp() {
    return Object.assign(new Help(), this.configureHelp());
  }
  /**
   * You can customise the help by overriding Help properties using configureHelp(),
   * or with a subclass of Help by overriding createHelp().
   *
   * @param {object} [configuration] - configuration options
   * @return {(Command | object)} `this` command for chaining, or stored configuration
   */
  configureHelp(configuration) {
    if (configuration === void 0) return this._helpConfiguration;
    this._helpConfiguration = configuration;
    return this;
  }
  /**
   * The default output goes to stdout and stderr. You can customise this for special
   * applications. You can also customise the display of errors by overriding outputError.
   *
   * The configuration properties are all functions:
   *
   *     // change how output being written, defaults to stdout and stderr
   *     writeOut(str)
   *     writeErr(str)
   *     // change how output being written for errors, defaults to writeErr
   *     outputError(str, write) // used for displaying errors and not used for displaying help
   *     // specify width for wrapping help
   *     getOutHelpWidth()
   *     getErrHelpWidth()
   *     // color support, currently only used with Help
   *     getOutHasColors()
   *     getErrHasColors()
   *     stripColor() // used to remove ANSI escape codes if output does not have colors
   *
   * @param {object} [configuration] - configuration options
   * @return {(Command | object)} `this` command for chaining, or stored configuration
   */
  configureOutput(configuration) {
    if (configuration === void 0) return this._outputConfiguration;
    this._outputConfiguration = {
      ...this._outputConfiguration,
      ...configuration
    };
    return this;
  }
  /**
   * Display the help or a custom message after an error occurs.
   *
   * @param {(boolean|string)} [displayHelp]
   * @return {Command} `this` command for chaining
   */
  showHelpAfterError(displayHelp = true) {
    if (typeof displayHelp !== "string") displayHelp = !!displayHelp;
    this._showHelpAfterError = displayHelp;
    return this;
  }
  /**
   * Display suggestion of similar commands for unknown commands, or options for unknown options.
   *
   * @param {boolean} [displaySuggestion]
   * @return {Command} `this` command for chaining
   */
  showSuggestionAfterError(displaySuggestion = true) {
    this._showSuggestionAfterError = !!displaySuggestion;
    return this;
  }
  /**
   * Add a prepared subcommand.
   *
   * See .command() for creating an attached subcommand which inherits settings from its parent.
   *
   * @param {Command} cmd - new subcommand
   * @param {object} [opts] - configuration options
   * @return {Command} `this` command for chaining
   */
  addCommand(cmd, opts) {
    if (!cmd._name) {
      throw new Error(`Command passed to .addCommand() must have a name
- specify the name in Command constructor or using .name()`);
    }
    opts = opts || {};
    if (opts.isDefault) this._defaultCommandName = cmd._name;
    if (opts.noHelp || opts.hidden) cmd._hidden = true;
    this._registerCommand(cmd);
    cmd.parent = this;
    cmd._checkForBrokenPassThrough();
    return this;
  }
  /**
   * Factory routine to create a new unattached argument.
   *
   * See .argument() for creating an attached argument, which uses this routine to
   * create the argument. You can override createArgument to return a custom argument.
   *
   * @param {string} name
   * @param {string} [description]
   * @return {Argument} new argument
   */
  createArgument(name, description) {
    return new Argument(name, description);
  }
  /**
   * Define argument syntax for command.
   *
   * The default is that the argument is required, and you can explicitly
   * indicate this with <> around the name. Put [] around the name for an optional argument.
   *
   * @example
   * program.argument('<input-file>');
   * program.argument('[output-file]');
   *
   * @param {string} name
   * @param {string} [description]
   * @param {(Function|*)} [parseArg] - custom argument processing function or default value
   * @param {*} [defaultValue]
   * @return {Command} `this` command for chaining
   */
  argument(name, description, parseArg, defaultValue) {
    const argument = this.createArgument(name, description);
    if (typeof parseArg === "function") {
      argument.default(defaultValue).argParser(parseArg);
    } else {
      argument.default(parseArg);
    }
    this.addArgument(argument);
    return this;
  }
  /**
   * Define argument syntax for command, adding multiple at once (without descriptions).
   *
   * See also .argument().
   *
   * @example
   * program.arguments('<cmd> [env]');
   *
   * @param {string} names
   * @return {Command} `this` command for chaining
   */
  arguments(names) {
    names.trim().split(/ +/).forEach((detail) => {
      this.argument(detail);
    });
    return this;
  }
  /**
   * Define argument syntax for command, adding a prepared argument.
   *
   * @param {Argument} argument
   * @return {Command} `this` command for chaining
   */
  addArgument(argument) {
    const previousArgument = this.registeredArguments.slice(-1)[0];
    if (previousArgument?.variadic) {
      throw new Error(
        `only the last argument can be variadic '${previousArgument.name()}'`
      );
    }
    if (argument.required && argument.defaultValue !== void 0 && argument.parseArg === void 0) {
      throw new Error(
        `a default value for a required argument is never used: '${argument.name()}'`
      );
    }
    this.registeredArguments.push(argument);
    return this;
  }
  /**
   * Customise or override default help command. By default a help command is automatically added if your command has subcommands.
   *
   * @example
   *    program.helpCommand('help [cmd]');
   *    program.helpCommand('help [cmd]', 'show help');
   *    program.helpCommand(false); // suppress default help command
   *    program.helpCommand(true); // add help command even if no subcommands
   *
   * @param {string|boolean} enableOrNameAndArgs - enable with custom name and/or arguments, or boolean to override whether added
   * @param {string} [description] - custom description
   * @return {Command} `this` command for chaining
   */
  helpCommand(enableOrNameAndArgs, description) {
    if (typeof enableOrNameAndArgs === "boolean") {
      this._addImplicitHelpCommand = enableOrNameAndArgs;
      if (enableOrNameAndArgs && this._defaultCommandGroup) {
        this._initCommandGroup(this._getHelpCommand());
      }
      return this;
    }
    const nameAndArgs = enableOrNameAndArgs ?? "help [command]";
    const [, helpName, helpArgs] = nameAndArgs.match(/([^ ]+) *(.*)/);
    const helpDescription = description ?? "display help for command";
    const helpCommand = this.createCommand(helpName);
    helpCommand.helpOption(false);
    if (helpArgs) helpCommand.arguments(helpArgs);
    if (helpDescription) helpCommand.description(helpDescription);
    this._addImplicitHelpCommand = true;
    this._helpCommand = helpCommand;
    if (enableOrNameAndArgs || description) this._initCommandGroup(helpCommand);
    return this;
  }
  /**
   * Add prepared custom help command.
   *
   * @param {(Command|string|boolean)} helpCommand - custom help command, or deprecated enableOrNameAndArgs as for `.helpCommand()`
   * @param {string} [deprecatedDescription] - deprecated custom description used with custom name only
   * @return {Command} `this` command for chaining
   */
  addHelpCommand(helpCommand, deprecatedDescription) {
    if (typeof helpCommand !== "object") {
      this.helpCommand(helpCommand, deprecatedDescription);
      return this;
    }
    this._addImplicitHelpCommand = true;
    this._helpCommand = helpCommand;
    this._initCommandGroup(helpCommand);
    return this;
  }
  /**
   * Lazy create help command.
   *
   * @return {(Command|null)}
   * @package
   */
  _getHelpCommand() {
    const hasImplicitHelpCommand = this._addImplicitHelpCommand ?? (this.commands.length && !this._actionHandler && !this._findCommand("help"));
    if (hasImplicitHelpCommand) {
      if (this._helpCommand === void 0) {
        this.helpCommand(void 0, void 0);
      }
      return this._helpCommand;
    }
    return null;
  }
  /**
   * Add hook for life cycle event.
   *
   * @param {string} event
   * @param {Function} listener
   * @return {Command} `this` command for chaining
   */
  hook(event, listener) {
    const allowedValues = ["preSubcommand", "preAction", "postAction"];
    if (!allowedValues.includes(event)) {
      throw new Error(`Unexpected value for event passed to hook : '${event}'.
Expecting one of '${allowedValues.join("', '")}'`);
    }
    if (this._lifeCycleHooks[event]) {
      this._lifeCycleHooks[event].push(listener);
    } else {
      this._lifeCycleHooks[event] = [listener];
    }
    return this;
  }
  /**
   * Register callback to use as replacement for calling process.exit.
   *
   * @param {Function} [fn] optional callback which will be passed a CommanderError, defaults to throwing
   * @return {Command} `this` command for chaining
   */
  exitOverride(fn) {
    if (fn) {
      this._exitCallback = fn;
    } else {
      this._exitCallback = (err) => {
        if (err.code !== "commander.executeSubCommandAsync") {
          throw err;
        } else {
        }
      };
    }
    return this;
  }
  /**
   * Call process.exit, and _exitCallback if defined.
   *
   * @param {number} exitCode exit code for using with process.exit
   * @param {string} code an id string representing the error
   * @param {string} message human-readable description of the error
   * @return never
   * @private
   */
  _exit(exitCode, code, message) {
    if (this._exitCallback) {
      this._exitCallback(new CommanderError(exitCode, code, message));
    }
    process2.exit(exitCode);
  }
  /**
   * Register callback `fn` for the command.
   *
   * @example
   * program
   *   .command('serve')
   *   .description('start service')
   *   .action(function() {
   *      // do work here
   *   });
   *
   * @param {Function} fn
   * @return {Command} `this` command for chaining
   */
  action(fn) {
    const listener = (args) => {
      const expectedArgsCount = this.registeredArguments.length;
      const actionArgs = args.slice(0, expectedArgsCount);
      if (this._storeOptionsAsProperties) {
        actionArgs[expectedArgsCount] = this;
      } else {
        actionArgs[expectedArgsCount] = this.opts();
      }
      actionArgs.push(this);
      return fn.apply(this, actionArgs);
    };
    this._actionHandler = listener;
    return this;
  }
  /**
   * Factory routine to create a new unattached option.
   *
   * See .option() for creating an attached option, which uses this routine to
   * create the option. You can override createOption to return a custom option.
   *
   * @param {string} flags
   * @param {string} [description]
   * @return {Option} new option
   */
  createOption(flags, description) {
    return new Option(flags, description);
  }
  /**
   * Wrap parseArgs to catch 'commander.invalidArgument'.
   *
   * @param {(Option | Argument)} target
   * @param {string} value
   * @param {*} previous
   * @param {string} invalidArgumentMessage
   * @private
   */
  _callParseArg(target, value, previous, invalidArgumentMessage) {
    try {
      return target.parseArg(value, previous);
    } catch (err) {
      if (err.code === "commander.invalidArgument") {
        const message = `${invalidArgumentMessage} ${err.message}`;
        this.error(message, { exitCode: err.exitCode, code: err.code });
      }
      throw err;
    }
  }
  /**
   * Check for option flag conflicts.
   * Register option if no conflicts found, or throw on conflict.
   *
   * @param {Option} option
   * @private
   */
  _registerOption(option) {
    const matchingOption = option.short && this._findOption(option.short) || option.long && this._findOption(option.long);
    if (matchingOption) {
      const matchingFlag = option.long && this._findOption(option.long) ? option.long : option.short;
      throw new Error(`Cannot add option '${option.flags}'${this._name && ` to command '${this._name}'`} due to conflicting flag '${matchingFlag}'
-  already used by option '${matchingOption.flags}'`);
    }
    this._initOptionGroup(option);
    this.options.push(option);
  }
  /**
   * Check for command name and alias conflicts with existing commands.
   * Register command if no conflicts found, or throw on conflict.
   *
   * @param {Command} command
   * @private
   */
  _registerCommand(command) {
    const knownBy = (cmd) => {
      return [cmd.name()].concat(cmd.aliases());
    };
    const alreadyUsed = knownBy(command).find(
      (name) => this._findCommand(name)
    );
    if (alreadyUsed) {
      const existingCmd = knownBy(this._findCommand(alreadyUsed)).join("|");
      const newCmd = knownBy(command).join("|");
      throw new Error(
        `cannot add command '${newCmd}' as already have command '${existingCmd}'`
      );
    }
    this._initCommandGroup(command);
    this.commands.push(command);
  }
  /**
   * Add an option.
   *
   * @param {Option} option
   * @return {Command} `this` command for chaining
   */
  addOption(option) {
    this._registerOption(option);
    const oname = option.name();
    const name = option.attributeName();
    if (option.defaultValue !== void 0) {
      this.setOptionValueWithSource(name, option.defaultValue, "default");
    }
    const handleOptionValue = (val, invalidValueMessage, valueSource) => {
      if (val == null && option.presetArg !== void 0) {
        val = option.presetArg;
      }
      const oldValue = this.getOptionValue(name);
      if (val !== null && option.parseArg) {
        val = this._callParseArg(option, val, oldValue, invalidValueMessage);
      } else if (val !== null && option.variadic) {
        val = option._collectValue(val, oldValue);
      }
      if (val == null) {
        if (option.negate) {
          val = false;
        } else if (option.isBoolean() || option.optional) {
          val = true;
        } else {
          val = "";
        }
      }
      this.setOptionValueWithSource(name, val, valueSource);
    };
    this.on("option:" + oname, (val) => {
      const invalidValueMessage = `error: option '${option.flags}' argument '${val}' is invalid.`;
      handleOptionValue(val, invalidValueMessage, "cli");
    });
    if (option.envVar) {
      this.on("optionEnv:" + oname, (val) => {
        const invalidValueMessage = `error: option '${option.flags}' value '${val}' from env '${option.envVar}' is invalid.`;
        handleOptionValue(val, invalidValueMessage, "env");
      });
    }
    return this;
  }
  /**
   * Internal implementation shared by .option() and .requiredOption()
   *
   * @return {Command} `this` command for chaining
   * @private
   */
  _optionEx(config, flags, description, fn, defaultValue) {
    if (typeof flags === "object" && flags instanceof Option) {
      throw new Error(
        "To add an Option object use addOption() instead of option() or requiredOption()"
      );
    }
    const option = this.createOption(flags, description);
    option.makeOptionMandatory(!!config.mandatory);
    if (typeof fn === "function") {
      option.default(defaultValue).argParser(fn);
    } else if (fn instanceof RegExp) {
      const regex = fn;
      fn = (val, def) => {
        const m2 = regex.exec(val);
        return m2 ? m2[0] : def;
      };
      option.default(defaultValue).argParser(fn);
    } else {
      option.default(fn);
    }
    return this.addOption(option);
  }
  /**
   * Define option with `flags`, `description`, and optional argument parsing function or `defaultValue` or both.
   *
   * The `flags` string contains the short and/or long flags, separated by comma, a pipe or space. A required
   * option-argument is indicated by `<>` and an optional option-argument by `[]`.
   *
   * See the README for more details, and see also addOption() and requiredOption().
   *
   * @example
   * program
   *     .option('-p, --pepper', 'add pepper')
   *     .option('--pt, --pizza-type <TYPE>', 'type of pizza') // required option-argument
   *     .option('-c, --cheese [CHEESE]', 'add extra cheese', 'mozzarella') // optional option-argument with default
   *     .option('-t, --tip <VALUE>', 'add tip to purchase cost', parseFloat) // custom parse function
   *
   * @param {string} flags
   * @param {string} [description]
   * @param {(Function|*)} [parseArg] - custom option processing function or default value
   * @param {*} [defaultValue]
   * @return {Command} `this` command for chaining
   */
  option(flags, description, parseArg, defaultValue) {
    return this._optionEx({}, flags, description, parseArg, defaultValue);
  }
  /**
   * Add a required option which must have a value after parsing. This usually means
   * the option must be specified on the command line. (Otherwise the same as .option().)
   *
   * The `flags` string contains the short and/or long flags, separated by comma, a pipe or space.
   *
   * @param {string} flags
   * @param {string} [description]
   * @param {(Function|*)} [parseArg] - custom option processing function or default value
   * @param {*} [defaultValue]
   * @return {Command} `this` command for chaining
   */
  requiredOption(flags, description, parseArg, defaultValue) {
    return this._optionEx(
      { mandatory: true },
      flags,
      description,
      parseArg,
      defaultValue
    );
  }
  /**
   * Alter parsing of short flags with optional values.
   *
   * @example
   * // for `.option('-f,--flag [value]'):
   * program.combineFlagAndOptionalValue(true);  // `-f80` is treated like `--flag=80`, this is the default behaviour
   * program.combineFlagAndOptionalValue(false) // `-fb` is treated like `-f -b`
   *
   * @param {boolean} [combine] - if `true` or omitted, an optional value can be specified directly after the flag.
   * @return {Command} `this` command for chaining
   */
  combineFlagAndOptionalValue(combine = true) {
    this._combineFlagAndOptionalValue = !!combine;
    return this;
  }
  /**
   * Allow unknown options on the command line.
   *
   * @param {boolean} [allowUnknown] - if `true` or omitted, no error will be thrown for unknown options.
   * @return {Command} `this` command for chaining
   */
  allowUnknownOption(allowUnknown = true) {
    this._allowUnknownOption = !!allowUnknown;
    return this;
  }
  /**
   * Allow excess command-arguments on the command line. Pass false to make excess arguments an error.
   *
   * @param {boolean} [allowExcess] - if `true` or omitted, no error will be thrown for excess arguments.
   * @return {Command} `this` command for chaining
   */
  allowExcessArguments(allowExcess = true) {
    this._allowExcessArguments = !!allowExcess;
    return this;
  }
  /**
   * Enable positional options. Positional means global options are specified before subcommands which lets
   * subcommands reuse the same option names, and also enables subcommands to turn on passThroughOptions.
   * The default behaviour is non-positional and global options may appear anywhere on the command line.
   *
   * @param {boolean} [positional]
   * @return {Command} `this` command for chaining
   */
  enablePositionalOptions(positional = true) {
    this._enablePositionalOptions = !!positional;
    return this;
  }
  /**
   * Pass through options that come after command-arguments rather than treat them as command-options,
   * so actual command-options come before command-arguments. Turning this on for a subcommand requires
   * positional options to have been enabled on the program (parent commands).
   * The default behaviour is non-positional and options may appear before or after command-arguments.
   *
   * @param {boolean} [passThrough] for unknown options.
   * @return {Command} `this` command for chaining
   */
  passThroughOptions(passThrough = true) {
    this._passThroughOptions = !!passThrough;
    this._checkForBrokenPassThrough();
    return this;
  }
  /**
   * @private
   */
  _checkForBrokenPassThrough() {
    if (this.parent && this._passThroughOptions && !this.parent._enablePositionalOptions) {
      throw new Error(
        `passThroughOptions cannot be used for '${this._name}' without turning on enablePositionalOptions for parent command(s)`
      );
    }
  }
  /**
   * Whether to store option values as properties on command object,
   * or store separately (specify false). In both cases the option values can be accessed using .opts().
   *
   * @param {boolean} [storeAsProperties=true]
   * @return {Command} `this` command for chaining
   */
  storeOptionsAsProperties(storeAsProperties = true) {
    if (this.options.length) {
      throw new Error("call .storeOptionsAsProperties() before adding options");
    }
    if (Object.keys(this._optionValues).length) {
      throw new Error(
        "call .storeOptionsAsProperties() before setting option values"
      );
    }
    this._storeOptionsAsProperties = !!storeAsProperties;
    return this;
  }
  /**
   * Retrieve option value.
   *
   * @param {string} key
   * @return {object} value
   */
  getOptionValue(key) {
    if (this._storeOptionsAsProperties) {
      return this[key];
    }
    return this._optionValues[key];
  }
  /**
   * Store option value.
   *
   * @param {string} key
   * @param {object} value
   * @return {Command} `this` command for chaining
   */
  setOptionValue(key, value) {
    return this.setOptionValueWithSource(key, value, void 0);
  }
  /**
   * Store option value and where the value came from.
   *
   * @param {string} key
   * @param {object} value
   * @param {string} source - expected values are default/config/env/cli/implied
   * @return {Command} `this` command for chaining
   */
  setOptionValueWithSource(key, value, source) {
    if (this._storeOptionsAsProperties) {
      this[key] = value;
    } else {
      this._optionValues[key] = value;
    }
    this._optionValueSources[key] = source;
    return this;
  }
  /**
   * Get source of option value.
   * Expected values are default | config | env | cli | implied
   *
   * @param {string} key
   * @return {string}
   */
  getOptionValueSource(key) {
    return this._optionValueSources[key];
  }
  /**
   * Get source of option value. See also .optsWithGlobals().
   * Expected values are default | config | env | cli | implied
   *
   * @param {string} key
   * @return {string}
   */
  getOptionValueSourceWithGlobals(key) {
    let source;
    this._getCommandAndAncestors().forEach((cmd) => {
      if (cmd.getOptionValueSource(key) !== void 0) {
        source = cmd.getOptionValueSource(key);
      }
    });
    return source;
  }
  /**
   * Get user arguments from implied or explicit arguments.
   * Side-effects: set _scriptPath if args included script. Used for default program name, and subcommand searches.
   *
   * @private
   */
  _prepareUserArgs(argv, parseOptions) {
    if (argv !== void 0 && !Array.isArray(argv)) {
      throw new Error("first parameter to parse must be array or undefined");
    }
    parseOptions = parseOptions || {};
    if (argv === void 0 && parseOptions.from === void 0) {
      if (process2.versions?.electron) {
        parseOptions.from = "electron";
      }
      const execArgv = process2.execArgv ?? [];
      if (execArgv.includes("-e") || execArgv.includes("--eval") || execArgv.includes("-p") || execArgv.includes("--print")) {
        parseOptions.from = "eval";
      }
    }
    if (argv === void 0) {
      argv = process2.argv;
    }
    this.rawArgs = argv.slice();
    let userArgs;
    switch (parseOptions.from) {
      case void 0:
      case "node":
        this._scriptPath = argv[1];
        userArgs = argv.slice(2);
        break;
      case "electron":
        if (process2.defaultApp) {
          this._scriptPath = argv[1];
          userArgs = argv.slice(2);
        } else {
          userArgs = argv.slice(1);
        }
        break;
      case "user":
        userArgs = argv.slice(0);
        break;
      case "eval":
        userArgs = argv.slice(1);
        break;
      default:
        throw new Error(
          `unexpected parse option { from: '${parseOptions.from}' }`
        );
    }
    if (!this._name && this._scriptPath)
      this.nameFromFilename(this._scriptPath);
    this._name = this._name || "program";
    return userArgs;
  }
  /**
   * Parse `argv`, setting options and invoking commands when defined.
   *
   * Use parseAsync instead of parse if any of your action handlers are async.
   *
   * Call with no parameters to parse `process.argv`. Detects Electron and special node options like `node --eval`. Easy mode!
   *
   * Or call with an array of strings to parse, and optionally where the user arguments start by specifying where the arguments are `from`:
   * - `'node'`: default, `argv[0]` is the application and `argv[1]` is the script being run, with user arguments after that
   * - `'electron'`: `argv[0]` is the application and `argv[1]` varies depending on whether the electron application is packaged
   * - `'user'`: just user arguments
   *
   * @example
   * program.parse(); // parse process.argv and auto-detect electron and special node flags
   * program.parse(process.argv); // assume argv[0] is app and argv[1] is script
   * program.parse(my-args, { from: 'user' }); // just user supplied arguments, nothing special about argv[0]
   *
   * @param {string[]} [argv] - optional, defaults to process.argv
   * @param {object} [parseOptions] - optionally specify style of options with from: node/user/electron
   * @param {string} [parseOptions.from] - where the args are from: 'node', 'user', 'electron'
   * @return {Command} `this` command for chaining
   */
  parse(argv, parseOptions) {
    this._prepareForParse();
    const userArgs = this._prepareUserArgs(argv, parseOptions);
    this._parseCommand([], userArgs);
    return this;
  }
  /**
   * Parse `argv`, setting options and invoking commands when defined.
   *
   * Call with no parameters to parse `process.argv`. Detects Electron and special node options like `node --eval`. Easy mode!
   *
   * Or call with an array of strings to parse, and optionally where the user arguments start by specifying where the arguments are `from`:
   * - `'node'`: default, `argv[0]` is the application and `argv[1]` is the script being run, with user arguments after that
   * - `'electron'`: `argv[0]` is the application and `argv[1]` varies depending on whether the electron application is packaged
   * - `'user'`: just user arguments
   *
   * @example
   * await program.parseAsync(); // parse process.argv and auto-detect electron and special node flags
   * await program.parseAsync(process.argv); // assume argv[0] is app and argv[1] is script
   * await program.parseAsync(my-args, { from: 'user' }); // just user supplied arguments, nothing special about argv[0]
   *
   * @param {string[]} [argv]
   * @param {object} [parseOptions]
   * @param {string} parseOptions.from - where the args are from: 'node', 'user', 'electron'
   * @return {Promise}
   */
  async parseAsync(argv, parseOptions) {
    this._prepareForParse();
    const userArgs = this._prepareUserArgs(argv, parseOptions);
    await this._parseCommand([], userArgs);
    return this;
  }
  _prepareForParse() {
    if (this._savedState === null) {
      this.options.filter(
        (option) => option.negate && option.defaultValue === void 0 && this.getOptionValue(option.attributeName()) === void 0
      ).forEach((option) => {
        const positiveLongFlag = option.long.replace(/^--no-/, "--");
        if (!this._findOption(positiveLongFlag)) {
          this.setOptionValueWithSource(
            option.attributeName(),
            true,
            "default"
          );
        }
      });
      this.saveStateBeforeParse();
    } else {
      this.restoreStateBeforeParse();
    }
  }
  /**
   * Called the first time parse is called to save state and allow a restore before subsequent calls to parse.
   * Not usually called directly, but available for subclasses to save their custom state.
   *
   * This is called in a lazy way. Only commands used in parsing chain will have state saved.
   */
  saveStateBeforeParse() {
    this._savedState = {
      // name is stable if supplied by author, but may be unspecified for root command and deduced during parsing
      _name: this._name,
      // option values before parse have default values (including false for negated options)
      // shallow clones
      _optionValues: { ...this._optionValues },
      _optionValueSources: { ...this._optionValueSources }
    };
  }
  /**
   * Restore state before parse for calls after the first.
   * Not usually called directly, but available for subclasses to save their custom state.
   *
   * This is called in a lazy way. Only commands used in parsing chain will have state restored.
   */
  restoreStateBeforeParse() {
    if (this._storeOptionsAsProperties)
      throw new Error(`Can not call parse again when storeOptionsAsProperties is true.
- either make a new Command for each call to parse, or stop storing options as properties`);
    this._name = this._savedState._name;
    this._scriptPath = null;
    this.rawArgs = [];
    this._optionValues = { ...this._savedState._optionValues };
    this._optionValueSources = { ...this._savedState._optionValueSources };
    this.args = [];
    this.processedArgs = [];
  }
  /**
   * Throw if expected executable is missing. Add lots of help for author.
   *
   * @param {string} executableFile
   * @param {string} executableDir
   * @param {string} subcommandName
   */
  _checkForMissingExecutable(executableFile, executableDir, subcommandName) {
    if (fs.existsSync(executableFile)) return;
    const executableDirMessage = executableDir ? `searched for local subcommand relative to directory '${executableDir}'` : "no directory for search for local subcommand, use .executableDir() to supply a custom directory";
    const executableMissing = `'${executableFile}' does not exist
 - if '${subcommandName}' is not meant to be an executable command, remove description parameter from '.command()' and use '.description()' instead
 - if the default executable name is not suitable, use the executableFile option to supply a custom name or path
 - ${executableDirMessage}`;
    throw new Error(executableMissing);
  }
  /**
   * Execute a sub-command executable.
   *
   * @private
   */
  _executeSubCommand(subcommand, args) {
    args = args.slice();
    const sourceExt = [".js", ".ts", ".tsx", ".mjs", ".cjs"];
    function findFile(baseDir, baseName) {
      const localBin = path.resolve(baseDir, baseName);
      if (fs.existsSync(localBin)) return localBin;
      if (sourceExt.includes(path.extname(baseName))) return void 0;
      const foundExt = sourceExt.find(
        (ext) => fs.existsSync(`${localBin}${ext}`)
      );
      if (foundExt) return `${localBin}${foundExt}`;
      return void 0;
    }
    this._checkForMissingMandatoryOptions();
    this._checkForConflictingOptions();
    let executableFile = subcommand._executableFile || `${this._name}-${subcommand._name}`;
    let executableDir = this._executableDir || "";
    if (this._scriptPath) {
      let resolvedScriptPath;
      try {
        resolvedScriptPath = fs.realpathSync(this._scriptPath);
      } catch {
        resolvedScriptPath = this._scriptPath;
      }
      executableDir = path.resolve(
        path.dirname(resolvedScriptPath),
        executableDir
      );
    }
    if (executableDir) {
      let localFile = findFile(executableDir, executableFile);
      if (!localFile && !subcommand._executableFile && this._scriptPath) {
        const legacyName = path.basename(
          this._scriptPath,
          path.extname(this._scriptPath)
        );
        if (legacyName !== this._name) {
          localFile = findFile(
            executableDir,
            `${legacyName}-${subcommand._name}`
          );
        }
      }
      executableFile = localFile || executableFile;
    }
    const launchWithNode = sourceExt.includes(path.extname(executableFile));
    let proc;
    if (process2.platform !== "win32") {
      if (launchWithNode) {
        args.unshift(executableFile);
        args = incrementNodeInspectorPort(process2.execArgv).concat(args);
        proc = childProcess.spawn(process2.argv[0], args, { stdio: "inherit" });
      } else {
        proc = childProcess.spawn(executableFile, args, { stdio: "inherit" });
      }
    } else {
      this._checkForMissingExecutable(
        executableFile,
        executableDir,
        subcommand._name
      );
      args.unshift(executableFile);
      args = incrementNodeInspectorPort(process2.execArgv).concat(args);
      proc = childProcess.spawn(process2.execPath, args, { stdio: "inherit" });
    }
    if (!proc.killed) {
      const signals = ["SIGUSR1", "SIGUSR2", "SIGTERM", "SIGINT", "SIGHUP"];
      signals.forEach((signal) => {
        process2.on(signal, () => {
          if (proc.killed === false && proc.exitCode === null) {
            proc.kill(signal);
          }
        });
      });
    }
    const exitCallback = this._exitCallback;
    proc.on("close", (code) => {
      code = code ?? 1;
      if (!exitCallback) {
        process2.exit(code);
      } else {
        exitCallback(
          new CommanderError(
            code,
            "commander.executeSubCommandAsync",
            "(close)"
          )
        );
      }
    });
    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        this._checkForMissingExecutable(
          executableFile,
          executableDir,
          subcommand._name
        );
      } else if (err.code === "EACCES") {
        throw new Error(`'${executableFile}' not executable`);
      }
      if (!exitCallback) {
        process2.exit(1);
      } else {
        const wrappedError = new CommanderError(
          1,
          "commander.executeSubCommandAsync",
          "(error)"
        );
        wrappedError.nestedError = err;
        exitCallback(wrappedError);
      }
    });
    this.runningCommand = proc;
  }
  /**
   * @private
   */
  _dispatchSubcommand(commandName, operands, unknown) {
    const subCommand = this._findCommand(commandName);
    if (!subCommand) this.help({ error: true });
    subCommand._prepareForParse();
    let promiseChain;
    promiseChain = this._chainOrCallSubCommandHook(
      promiseChain,
      subCommand,
      "preSubcommand"
    );
    promiseChain = this._chainOrCall(promiseChain, () => {
      if (subCommand._executableHandler) {
        this._executeSubCommand(subCommand, operands.concat(unknown));
      } else {
        return subCommand._parseCommand(operands, unknown);
      }
    });
    return promiseChain;
  }
  /**
   * Invoke help directly if possible, or dispatch if necessary.
   * e.g. help foo
   *
   * @private
   */
  _dispatchHelpCommand(subcommandName) {
    if (!subcommandName) {
      this.help();
    }
    const subCommand = this._findCommand(subcommandName);
    if (subCommand && !subCommand._executableHandler) {
      subCommand.help();
    }
    return this._dispatchSubcommand(
      subcommandName,
      [],
      [this._getHelpOption()?.long ?? this._getHelpOption()?.short ?? "--help"]
    );
  }
  /**
   * Check this.args against expected this.registeredArguments.
   *
   * @private
   */
  _checkNumberOfArguments() {
    this.registeredArguments.forEach((arg, i) => {
      if (arg.required && this.args[i] == null) {
        this.missingArgument(arg.name());
      }
    });
    if (this.registeredArguments.length > 0 && this.registeredArguments[this.registeredArguments.length - 1].variadic) {
      return;
    }
    if (this.args.length > this.registeredArguments.length) {
      this._excessArguments(this.args);
    }
  }
  /**
   * Process this.args using this.registeredArguments and save as this.processedArgs!
   *
   * @private
   */
  _processArguments() {
    const myParseArg = (argument, value, previous) => {
      let parsedValue = value;
      if (value !== null && argument.parseArg) {
        const invalidValueMessage = `error: command-argument value '${value}' is invalid for argument '${argument.name()}'.`;
        parsedValue = this._callParseArg(
          argument,
          value,
          previous,
          invalidValueMessage
        );
      }
      return parsedValue;
    };
    this._checkNumberOfArguments();
    const processedArgs = [];
    this.registeredArguments.forEach((declaredArg, index) => {
      let value = declaredArg.defaultValue;
      if (declaredArg.variadic) {
        if (index < this.args.length) {
          value = this.args.slice(index);
          if (declaredArg.parseArg) {
            value = value.reduce((processed, v2) => {
              return myParseArg(declaredArg, v2, processed);
            }, declaredArg.defaultValue);
          }
        } else if (value === void 0) {
          value = [];
        }
      } else if (index < this.args.length) {
        value = this.args[index];
        if (declaredArg.parseArg) {
          value = myParseArg(declaredArg, value, declaredArg.defaultValue);
        }
      }
      processedArgs[index] = value;
    });
    this.processedArgs = processedArgs;
  }
  /**
   * Once we have a promise we chain, but call synchronously until then.
   *
   * @param {(Promise|undefined)} promise
   * @param {Function} fn
   * @return {(Promise|undefined)}
   * @private
   */
  _chainOrCall(promise, fn) {
    if (promise?.then && typeof promise.then === "function") {
      return promise.then(() => fn());
    }
    return fn();
  }
  /**
   *
   * @param {(Promise|undefined)} promise
   * @param {string} event
   * @return {(Promise|undefined)}
   * @private
   */
  _chainOrCallHooks(promise, event) {
    let result = promise;
    const hooks = [];
    this._getCommandAndAncestors().reverse().filter((cmd) => cmd._lifeCycleHooks[event] !== void 0).forEach((hookedCommand) => {
      hookedCommand._lifeCycleHooks[event].forEach((callback) => {
        hooks.push({ hookedCommand, callback });
      });
    });
    if (event === "postAction") {
      hooks.reverse();
    }
    hooks.forEach((hookDetail) => {
      result = this._chainOrCall(result, () => {
        return hookDetail.callback(hookDetail.hookedCommand, this);
      });
    });
    return result;
  }
  /**
   *
   * @param {(Promise|undefined)} promise
   * @param {Command} subCommand
   * @param {string} event
   * @return {(Promise|undefined)}
   * @private
   */
  _chainOrCallSubCommandHook(promise, subCommand, event) {
    let result = promise;
    if (this._lifeCycleHooks[event] !== void 0) {
      this._lifeCycleHooks[event].forEach((hook) => {
        result = this._chainOrCall(result, () => {
          return hook(this, subCommand);
        });
      });
    }
    return result;
  }
  /**
   * Process arguments in context of this command.
   * Returns action result, in case it is a promise.
   *
   * @private
   */
  _parseCommand(operands, unknown) {
    const parsed = this.parseOptions(unknown);
    this._parseOptionsEnv();
    this._parseOptionsImplied();
    operands = operands.concat(parsed.operands);
    unknown = parsed.unknown;
    this.args = operands.concat(unknown);
    if (operands && this._findCommand(operands[0])) {
      return this._dispatchSubcommand(operands[0], operands.slice(1), unknown);
    }
    if (this._getHelpCommand() && operands[0] === this._getHelpCommand().name()) {
      return this._dispatchHelpCommand(operands[1]);
    }
    if (this._defaultCommandName) {
      this._outputHelpIfRequested(unknown);
      return this._dispatchSubcommand(
        this._defaultCommandName,
        operands,
        unknown
      );
    }
    if (this.commands.length && this.args.length === 0 && !this._actionHandler && !this._defaultCommandName) {
      this.help({ error: true });
    }
    this._outputHelpIfRequested(parsed.unknown);
    this._checkForMissingMandatoryOptions();
    this._checkForConflictingOptions();
    const checkForUnknownOptions = () => {
      if (parsed.unknown.length > 0) {
        this.unknownOption(parsed.unknown[0]);
      }
    };
    const commandEvent = `command:${this.name()}`;
    if (this._actionHandler) {
      checkForUnknownOptions();
      this._processArguments();
      let promiseChain;
      promiseChain = this._chainOrCallHooks(promiseChain, "preAction");
      promiseChain = this._chainOrCall(
        promiseChain,
        () => this._actionHandler(this.processedArgs)
      );
      if (this.parent) {
        promiseChain = this._chainOrCall(promiseChain, () => {
          this.parent.emit(commandEvent, operands, unknown);
        });
      }
      promiseChain = this._chainOrCallHooks(promiseChain, "postAction");
      return promiseChain;
    }
    if (this.parent?.listenerCount(commandEvent)) {
      checkForUnknownOptions();
      this._processArguments();
      this.parent.emit(commandEvent, operands, unknown);
    } else if (operands.length) {
      if (this._findCommand("*")) {
        return this._dispatchSubcommand("*", operands, unknown);
      }
      if (this.listenerCount("command:*")) {
        this.emit("command:*", operands, unknown);
      } else if (this.commands.length) {
        this.unknownCommand();
      } else {
        checkForUnknownOptions();
        this._processArguments();
      }
    } else if (this.commands.length) {
      checkForUnknownOptions();
      this.help({ error: true });
    } else {
      checkForUnknownOptions();
      this._processArguments();
    }
  }
  /**
   * Find matching command.
   *
   * @private
   * @return {Command | undefined}
   */
  _findCommand(name) {
    if (!name) return void 0;
    return this.commands.find(
      (cmd) => cmd._name === name || cmd._aliases.includes(name)
    );
  }
  /**
   * Return an option matching `arg` if any.
   *
   * @param {string} arg
   * @return {Option}
   * @package
   */
  _findOption(arg) {
    return this.options.find((option) => option.is(arg));
  }
  /**
   * Display an error message if a mandatory option does not have a value.
   * Called after checking for help flags in leaf subcommand.
   *
   * @private
   */
  _checkForMissingMandatoryOptions() {
    this._getCommandAndAncestors().forEach((cmd) => {
      cmd.options.forEach((anOption) => {
        if (anOption.mandatory && cmd.getOptionValue(anOption.attributeName()) === void 0) {
          cmd.missingMandatoryOptionValue(anOption);
        }
      });
    });
  }
  /**
   * Display an error message if conflicting options are used together in this.
   *
   * @private
   */
  _checkForConflictingLocalOptions() {
    const definedNonDefaultOptions = this.options.filter((option) => {
      const optionKey = option.attributeName();
      if (this.getOptionValue(optionKey) === void 0) {
        return false;
      }
      return this.getOptionValueSource(optionKey) !== "default";
    });
    const optionsWithConflicting = definedNonDefaultOptions.filter(
      (option) => option.conflictsWith.length > 0
    );
    optionsWithConflicting.forEach((option) => {
      const conflictingAndDefined = definedNonDefaultOptions.find(
        (defined) => option.conflictsWith.includes(defined.attributeName())
      );
      if (conflictingAndDefined) {
        this._conflictingOption(option, conflictingAndDefined);
      }
    });
  }
  /**
   * Display an error message if conflicting options are used together.
   * Called after checking for help flags in leaf subcommand.
   *
   * @private
   */
  _checkForConflictingOptions() {
    this._getCommandAndAncestors().forEach((cmd) => {
      cmd._checkForConflictingLocalOptions();
    });
  }
  /**
   * Parse options from `argv` removing known options,
   * and return argv split into operands and unknown arguments.
   *
   * Side effects: modifies command by storing options. Does not reset state if called again.
   *
   * Examples:
   *
   *     argv => operands, unknown
   *     --known kkk op => [op], []
   *     op --known kkk => [op], []
   *     sub --unknown uuu op => [sub], [--unknown uuu op]
   *     sub -- --unknown uuu op => [sub --unknown uuu op], []
   *
   * @param {string[]} args
   * @return {{operands: string[], unknown: string[]}}
   */
  parseOptions(args) {
    const operands = [];
    const unknown = [];
    let dest = operands;
    function maybeOption(arg) {
      return arg.length > 1 && arg[0] === "-";
    }
    const negativeNumberArg = (arg) => {
      if (!/^-(\d+|\d*\.\d+)(e[+-]?\d+)?$/.test(arg)) return false;
      return !this._getCommandAndAncestors().some(
        (cmd) => cmd.options.map((opt) => opt.short).some((short) => /^-\d$/.test(short))
      );
    };
    let activeVariadicOption = null;
    let activeGroup = null;
    let i = 0;
    while (i < args.length || activeGroup) {
      const arg = activeGroup ?? args[i++];
      activeGroup = null;
      if (arg === "--") {
        if (dest === unknown) dest.push(arg);
        dest.push(...args.slice(i));
        break;
      }
      if (activeVariadicOption && (!maybeOption(arg) || negativeNumberArg(arg))) {
        this.emit(`option:${activeVariadicOption.name()}`, arg);
        continue;
      }
      activeVariadicOption = null;
      if (maybeOption(arg)) {
        const option = this._findOption(arg);
        if (option) {
          if (option.required) {
            const value = args[i++];
            if (value === void 0) this.optionMissingArgument(option);
            this.emit(`option:${option.name()}`, value);
          } else if (option.optional) {
            let value = null;
            if (i < args.length && (!maybeOption(args[i]) || negativeNumberArg(args[i]))) {
              value = args[i++];
            }
            this.emit(`option:${option.name()}`, value);
          } else {
            this.emit(`option:${option.name()}`);
          }
          activeVariadicOption = option.variadic ? option : null;
          continue;
        }
      }
      if (arg.length > 2 && arg[0] === "-" && arg[1] !== "-") {
        const option = this._findOption(`-${arg[1]}`);
        if (option) {
          if (option.required || option.optional && this._combineFlagAndOptionalValue) {
            this.emit(`option:${option.name()}`, arg.slice(2));
          } else {
            this.emit(`option:${option.name()}`);
            activeGroup = `-${arg.slice(2)}`;
          }
          continue;
        }
      }
      if (/^--[^=]+=/.test(arg)) {
        const index = arg.indexOf("=");
        const option = this._findOption(arg.slice(0, index));
        if (option && (option.required || option.optional)) {
          this.emit(`option:${option.name()}`, arg.slice(index + 1));
          continue;
        }
      }
      if (dest === operands && maybeOption(arg) && !(this.commands.length === 0 && negativeNumberArg(arg))) {
        dest = unknown;
      }
      if ((this._enablePositionalOptions || this._passThroughOptions) && operands.length === 0 && unknown.length === 0) {
        if (this._findCommand(arg)) {
          operands.push(arg);
          unknown.push(...args.slice(i));
          break;
        } else if (this._getHelpCommand() && arg === this._getHelpCommand().name()) {
          operands.push(arg, ...args.slice(i));
          break;
        } else if (this._defaultCommandName) {
          unknown.push(arg, ...args.slice(i));
          break;
        }
      }
      if (this._passThroughOptions) {
        dest.push(arg, ...args.slice(i));
        break;
      }
      dest.push(arg);
    }
    return { operands, unknown };
  }
  /**
   * Return an object containing local option values as key-value pairs.
   *
   * @return {object}
   */
  opts() {
    if (this._storeOptionsAsProperties) {
      const result = {};
      const len = this.options.length;
      for (let i = 0; i < len; i++) {
        const key = this.options[i].attributeName();
        result[key] = key === this._versionOptionName ? this._version : this[key];
      }
      return result;
    }
    return this._optionValues;
  }
  /**
   * Return an object containing merged local and global option values as key-value pairs.
   *
   * @return {object}
   */
  optsWithGlobals() {
    return this._getCommandAndAncestors().reduce(
      (combinedOptions, cmd) => Object.assign(combinedOptions, cmd.opts()),
      {}
    );
  }
  /**
   * Display error message and exit (or call exitOverride).
   *
   * @param {string} message
   * @param {object} [errorOptions]
   * @param {string} [errorOptions.code] - an id string representing the error
   * @param {number} [errorOptions.exitCode] - used with process.exit
   */
  error(message, errorOptions) {
    this._outputConfiguration.outputError(
      `${message}
`,
      this._outputConfiguration.writeErr
    );
    if (typeof this._showHelpAfterError === "string") {
      this._outputConfiguration.writeErr(`${this._showHelpAfterError}
`);
    } else if (this._showHelpAfterError) {
      this._outputConfiguration.writeErr("\n");
      this.outputHelp({ error: true });
    }
    const config = errorOptions || {};
    const exitCode = config.exitCode || 1;
    const code = config.code || "commander.error";
    this._exit(exitCode, code, message);
  }
  /**
   * Apply any option related environment variables, if option does
   * not have a value from cli or client code.
   *
   * @private
   */
  _parseOptionsEnv() {
    this.options.forEach((option) => {
      if (option.envVar && option.envVar in process2.env) {
        const optionKey = option.attributeName();
        if (this.getOptionValue(optionKey) === void 0 || ["default", "config", "env"].includes(
          this.getOptionValueSource(optionKey)
        )) {
          if (option.required || option.optional) {
            this.emit(`optionEnv:${option.name()}`, process2.env[option.envVar]);
          } else {
            this.emit(`optionEnv:${option.name()}`);
          }
        }
      }
    });
  }
  /**
   * Apply any implied option values, if option is undefined or default value.
   *
   * @private
   */
  _parseOptionsImplied() {
    const dualHelper = new DualOptions(this.options);
    const hasCustomOptionValue = (optionKey) => {
      return this.getOptionValue(optionKey) !== void 0 && !["default", "implied"].includes(this.getOptionValueSource(optionKey));
    };
    this.options.filter(
      (option) => option.implied !== void 0 && hasCustomOptionValue(option.attributeName()) && dualHelper.valueFromOption(
        this.getOptionValue(option.attributeName()),
        option
      )
    ).forEach((option) => {
      Object.keys(option.implied).filter((impliedKey) => !hasCustomOptionValue(impliedKey)).forEach((impliedKey) => {
        this.setOptionValueWithSource(
          impliedKey,
          option.implied[impliedKey],
          "implied"
        );
      });
    });
  }
  /**
   * Argument `name` is missing.
   *
   * @param {string} name
   * @private
   */
  missingArgument(name) {
    const message = `error: missing required argument '${name}'`;
    this.error(message, { code: "commander.missingArgument" });
  }
  /**
   * `Option` is missing an argument.
   *
   * @param {Option} option
   * @private
   */
  optionMissingArgument(option) {
    const message = `error: option '${option.flags}' argument missing`;
    this.error(message, { code: "commander.optionMissingArgument" });
  }
  /**
   * `Option` does not have a value, and is a mandatory option.
   *
   * @param {Option} option
   * @private
   */
  missingMandatoryOptionValue(option) {
    const message = `error: required option '${option.flags}' not specified`;
    this.error(message, { code: "commander.missingMandatoryOptionValue" });
  }
  /**
   * `Option` conflicts with another option.
   *
   * @param {Option} option
   * @param {Option} conflictingOption
   * @private
   */
  _conflictingOption(option, conflictingOption) {
    const findBestOptionFromValue = (option2) => {
      const optionKey = option2.attributeName();
      const optionValue = this.getOptionValue(optionKey);
      const negativeOption = this.options.find(
        (target) => target.negate && optionKey === target.attributeName()
      );
      const positiveOption = this.options.find(
        (target) => !target.negate && optionKey === target.attributeName()
      );
      if (negativeOption && (negativeOption.presetArg === void 0 && optionValue === false || negativeOption.presetArg !== void 0 && optionValue === negativeOption.presetArg)) {
        return negativeOption;
      }
      return positiveOption || option2;
    };
    const getErrorMessage = (option2) => {
      const bestOption = findBestOptionFromValue(option2);
      const optionKey = bestOption.attributeName();
      const source = this.getOptionValueSource(optionKey);
      if (source === "env") {
        return `environment variable '${bestOption.envVar}'`;
      }
      return `option '${bestOption.flags}'`;
    };
    const message = `error: ${getErrorMessage(option)} cannot be used with ${getErrorMessage(conflictingOption)}`;
    this.error(message, { code: "commander.conflictingOption" });
  }
  /**
   * Unknown option `flag`.
   *
   * @param {string} flag
   * @private
   */
  unknownOption(flag) {
    if (this._allowUnknownOption) return;
    let suggestion = "";
    if (flag.startsWith("--") && this._showSuggestionAfterError) {
      let candidateFlags = [];
      let command = this;
      do {
        const moreFlags = command.createHelp().visibleOptions(command).filter((option) => option.long).map((option) => option.long);
        candidateFlags = candidateFlags.concat(moreFlags);
        command = command.parent;
      } while (command && !command._enablePositionalOptions);
      suggestion = suggestSimilar(flag, candidateFlags);
    }
    const message = `error: unknown option '${flag}'${suggestion}`;
    this.error(message, { code: "commander.unknownOption" });
  }
  /**
   * Excess arguments, more than expected.
   *
   * @param {string[]} receivedArgs
   * @private
   */
  _excessArguments(receivedArgs) {
    if (this._allowExcessArguments) return;
    const expected = this.registeredArguments.length;
    const s = expected === 1 ? "" : "s";
    const received = receivedArgs.length;
    const forSubcommand = this.parent ? ` for '${this.name()}'` : "";
    const details = receivedArgs.join(", ");
    const message = `error: too many arguments${forSubcommand}. Expected ${expected} argument${s} but got ${received}: ${details}.`;
    this.error(message, { code: "commander.excessArguments" });
  }
  /**
   * Unknown command.
   *
   * @private
   */
  unknownCommand() {
    const unknownName = this.args[0];
    let suggestion = "";
    if (this._showSuggestionAfterError) {
      const candidateNames = [];
      this.createHelp().visibleCommands(this).forEach((command) => {
        candidateNames.push(command.name());
        if (command.alias()) candidateNames.push(command.alias());
      });
      suggestion = suggestSimilar(unknownName, candidateNames);
    }
    const message = `error: unknown command '${unknownName}'${suggestion}`;
    this.error(message, { code: "commander.unknownCommand" });
  }
  /**
   * Get or set the program version.
   *
   * This method auto-registers the "-V, --version" option which will print the version number.
   *
   * You can optionally supply the flags and description to override the defaults.
   *
   * @param {string} [str]
   * @param {string} [flags]
   * @param {string} [description]
   * @return {(this | string | undefined)} `this` command for chaining, or version string if no arguments
   */
  version(str, flags, description) {
    if (str === void 0) return this._version;
    this._version = str;
    flags = flags || "-V, --version";
    description = description || "output the version number";
    const versionOption = this.createOption(flags, description);
    this._versionOptionName = versionOption.attributeName();
    this._registerOption(versionOption);
    this.on("option:" + versionOption.name(), () => {
      this._outputConfiguration.writeOut(`${str}
`);
      this._exit(0, "commander.version", str);
    });
    return this;
  }
  /**
   * Set the description.
   *
   * @param {string} [str]
   * @param {object} [argsDescription]
   * @return {(string|Command)}
   */
  description(str, argsDescription) {
    if (str === void 0 && argsDescription === void 0)
      return this._description;
    this._description = str;
    if (argsDescription) {
      this._argsDescription = argsDescription;
    }
    return this;
  }
  /**
   * Set the summary. Used when listed as subcommand of parent.
   *
   * @param {string} [str]
   * @return {(string|Command)}
   */
  summary(str) {
    if (str === void 0) return this._summary;
    this._summary = str;
    return this;
  }
  /**
   * Set an alias for the command.
   *
   * You may call more than once to add multiple aliases. Only the first alias is shown in the auto-generated help.
   *
   * @param {string} [alias]
   * @return {(string|Command)}
   */
  alias(alias) {
    if (alias === void 0) return this._aliases[0];
    let command = this;
    if (this.commands.length !== 0 && this.commands[this.commands.length - 1]._executableHandler) {
      command = this.commands[this.commands.length - 1];
    }
    if (alias === command._name)
      throw new Error("Command alias can't be the same as its name");
    const matchingCommand = this.parent?._findCommand(alias);
    if (matchingCommand) {
      const existingCmd = [matchingCommand.name()].concat(matchingCommand.aliases()).join("|");
      throw new Error(
        `cannot add alias '${alias}' to command '${this.name()}' as already have command '${existingCmd}'`
      );
    }
    command._aliases.push(alias);
    return this;
  }
  /**
   * Set aliases for the command.
   *
   * Only the first alias is shown in the auto-generated help.
   *
   * @param {string[]} [aliases]
   * @return {(string[]|Command)}
   */
  aliases(aliases) {
    if (aliases === void 0) return this._aliases;
    aliases.forEach((alias) => this.alias(alias));
    return this;
  }
  /**
   * Set / get the command usage `str`.
   *
   * @param {string} [str]
   * @return {(string|Command)}
   */
  usage(str) {
    if (str === void 0) {
      if (this._usage) return this._usage;
      const args = this.registeredArguments.map((arg) => {
        return humanReadableArgName(arg);
      });
      return [].concat(
        this.options.length || this._helpOption !== null ? "[options]" : [],
        this.commands.length ? "[command]" : [],
        this.registeredArguments.length ? args : []
      ).join(" ");
    }
    this._usage = str;
    return this;
  }
  /**
   * Get or set the name of the command.
   *
   * @param {string} [str]
   * @return {(string|Command)}
   */
  name(str) {
    if (str === void 0) return this._name;
    this._name = str;
    return this;
  }
  /**
   * Set/get the help group heading for this subcommand in parent command's help.
   *
   * @param {string} [heading]
   * @return {Command | string}
   */
  helpGroup(heading) {
    if (heading === void 0) return this._helpGroupHeading ?? "";
    this._helpGroupHeading = heading;
    return this;
  }
  /**
   * Set/get the default help group heading for subcommands added to this command.
   * (This does not override a group set directly on the subcommand using .helpGroup().)
   *
   * @example
   * program.commandsGroup('Development Commands:);
   * program.command('watch')...
   * program.command('lint')...
   * ...
   *
   * @param {string} [heading]
   * @returns {Command | string}
   */
  commandsGroup(heading) {
    if (heading === void 0) return this._defaultCommandGroup ?? "";
    this._defaultCommandGroup = heading;
    return this;
  }
  /**
   * Set/get the default help group heading for options added to this command.
   * (This does not override a group set directly on the option using .helpGroup().)
   *
   * @example
   * program
   *   .optionsGroup('Development Options:')
   *   .option('-d, --debug', 'output extra debugging')
   *   .option('-p, --profile', 'output profiling information')
   *
   * @param {string} [heading]
   * @returns {Command | string}
   */
  optionsGroup(heading) {
    if (heading === void 0) return this._defaultOptionGroup ?? "";
    this._defaultOptionGroup = heading;
    return this;
  }
  /**
   * @param {Option} option
   * @private
   */
  _initOptionGroup(option) {
    if (this._defaultOptionGroup && !option.helpGroupHeading)
      option.helpGroup(this._defaultOptionGroup);
  }
  /**
   * @param {Command} cmd
   * @private
   */
  _initCommandGroup(cmd) {
    if (this._defaultCommandGroup && !cmd.helpGroup())
      cmd.helpGroup(this._defaultCommandGroup);
  }
  /**
   * Set the name of the command from script filename, such as process.argv[1],
   * or import.meta.filename.
   *
   * (Used internally and public although not documented in README.)
   *
   * @example
   * program.nameFromFilename(import.meta.filename);
   *
   * @param {string} filename
   * @return {Command}
   */
  nameFromFilename(filename) {
    this._name = path.basename(filename, path.extname(filename));
    return this;
  }
  /**
   * Get or set the directory for searching for executable subcommands of this command.
   *
   * @example
   * program.executableDir(import.meta.dirname);
   * // or
   * program.executableDir('subcommands');
   *
   * @param {string} [path]
   * @return {(string|null|Command)}
   */
  executableDir(path5) {
    if (path5 === void 0) return this._executableDir;
    this._executableDir = path5;
    return this;
  }
  /**
   * Return program help documentation.
   *
   * @param {{ error: boolean }} [contextOptions] - pass {error:true} to wrap for stderr instead of stdout
   * @return {string}
   */
  helpInformation(contextOptions) {
    const helper = this.createHelp();
    const context = this._getOutputContext(contextOptions);
    helper.prepareContext({
      error: context.error,
      helpWidth: context.helpWidth,
      outputHasColors: context.hasColors
    });
    const text = helper.formatHelp(this, helper);
    if (context.hasColors) return text;
    return this._outputConfiguration.stripColor(text);
  }
  /**
   * @typedef HelpContext
   * @type {object}
   * @property {boolean} error
   * @property {number} helpWidth
   * @property {boolean} hasColors
   * @property {function} write - includes stripColor if needed
   *
   * @returns {HelpContext}
   * @private
   */
  _getOutputContext(contextOptions) {
    contextOptions = contextOptions || {};
    const error = !!contextOptions.error;
    let baseWrite;
    let hasColors;
    let helpWidth;
    if (error) {
      baseWrite = (str) => this._outputConfiguration.writeErr(str);
      hasColors = this._outputConfiguration.getErrHasColors();
      helpWidth = this._outputConfiguration.getErrHelpWidth();
    } else {
      baseWrite = (str) => this._outputConfiguration.writeOut(str);
      hasColors = this._outputConfiguration.getOutHasColors();
      helpWidth = this._outputConfiguration.getOutHelpWidth();
    }
    const write = (str) => {
      if (!hasColors) str = this._outputConfiguration.stripColor(str);
      return baseWrite(str);
    };
    return { error, write, hasColors, helpWidth };
  }
  /**
   * Output help information for this command.
   *
   * Outputs built-in help, and custom text added using `.addHelpText()`.
   *
   * @param {{ error: boolean } | Function} [contextOptions] - pass {error:true} to write to stderr instead of stdout
   */
  outputHelp(contextOptions) {
    let deprecatedCallback;
    if (typeof contextOptions === "function") {
      deprecatedCallback = contextOptions;
      contextOptions = void 0;
    }
    const outputContext = this._getOutputContext(contextOptions);
    const eventContext = {
      error: outputContext.error,
      write: outputContext.write,
      command: this
    };
    this._getCommandAndAncestors().reverse().forEach((command) => command.emit("beforeAllHelp", eventContext));
    this.emit("beforeHelp", eventContext);
    let helpInformation = this.helpInformation({ error: outputContext.error });
    if (deprecatedCallback) {
      helpInformation = deprecatedCallback(helpInformation);
      if (typeof helpInformation !== "string" && !Buffer.isBuffer(helpInformation)) {
        throw new Error("outputHelp callback must return a string or a Buffer");
      }
    }
    outputContext.write(helpInformation);
    if (this._getHelpOption()?.long) {
      this.emit(this._getHelpOption().long);
    }
    this.emit("afterHelp", eventContext);
    this._getCommandAndAncestors().forEach(
      (command) => command.emit("afterAllHelp", eventContext)
    );
  }
  /**
   * You can pass in flags and a description to customise the built-in help option.
   * Pass in false to disable the built-in help option.
   *
   * @example
   * program.helpOption('-?, --help' 'show help'); // customise
   * program.helpOption(false); // disable
   *
   * @param {(string | boolean)} flags
   * @param {string} [description]
   * @return {Command} `this` command for chaining
   */
  helpOption(flags, description) {
    if (typeof flags === "boolean") {
      if (flags) {
        if (this._helpOption === null) this._helpOption = void 0;
        if (this._defaultOptionGroup) {
          this._initOptionGroup(this._getHelpOption());
        }
      } else {
        this._helpOption = null;
      }
      return this;
    }
    this._helpOption = this.createOption(
      flags ?? "-h, --help",
      description ?? "display help for command"
    );
    if (flags || description) this._initOptionGroup(this._helpOption);
    return this;
  }
  /**
   * Lazy create help option.
   * Returns null if has been disabled with .helpOption(false).
   *
   * @returns {(Option | null)} the help option
   * @package
   */
  _getHelpOption() {
    if (this._helpOption === void 0) {
      this.helpOption(void 0, void 0);
    }
    return this._helpOption;
  }
  /**
   * Supply your own option to use for the built-in help option.
   * This is an alternative to using helpOption() to customise the flags and description etc.
   *
   * @param {Option} option
   * @return {Command} `this` command for chaining
   */
  addHelpOption(option) {
    this._helpOption = option;
    this._initOptionGroup(option);
    return this;
  }
  /**
   * Output help information and exit.
   *
   * Outputs built-in help, and custom text added using `.addHelpText()`.
   *
   * @param {{ error: boolean }} [contextOptions] - pass {error:true} to write to stderr instead of stdout
   */
  help(contextOptions) {
    this.outputHelp(contextOptions);
    let exitCode = Number(process2.exitCode ?? 0);
    if (exitCode === 0 && contextOptions && typeof contextOptions !== "function" && contextOptions.error) {
      exitCode = 1;
    }
    this._exit(exitCode, "commander.help", "(outputHelp)");
  }
  /**
   * // Do a little typing to coordinate emit and listener for the help text events.
   * @typedef HelpTextEventContext
   * @type {object}
   * @property {boolean} error
   * @property {Command} command
   * @property {function} write
   */
  /**
   * Add additional text to be displayed with the built-in help.
   *
   * Position is 'before' or 'after' to affect just this command,
   * and 'beforeAll' or 'afterAll' to affect this command and all its subcommands.
   *
   * @param {string} position - before or after built-in help
   * @param {(string | Function)} text - string to add, or a function returning a string
   * @return {Command} `this` command for chaining
   */
  addHelpText(position, text) {
    const allowedValues = ["beforeAll", "before", "after", "afterAll"];
    if (!allowedValues.includes(position)) {
      throw new Error(`Unexpected value for position to addHelpText.
Expecting one of '${allowedValues.join("', '")}'`);
    }
    const helpEvent = `${position}Help`;
    this.on(helpEvent, (context) => {
      let helpStr;
      if (typeof text === "function") {
        helpStr = text({ error: context.error, command: context.command });
      } else {
        helpStr = text;
      }
      if (helpStr) {
        context.write(`${helpStr}
`);
      }
    });
    return this;
  }
  /**
   * Output help information if help flags specified
   *
   * @param {Array} args - array of options to search for help flags
   * @private
   */
  _outputHelpIfRequested(args) {
    const helpOption = this._getHelpOption();
    const helpRequested = helpOption && args.find((arg) => helpOption.is(arg));
    if (helpRequested) {
      this.outputHelp();
      this._exit(0, "commander.helpDisplayed", "(outputHelp)");
    }
  }
};
function incrementNodeInspectorPort(args) {
  return args.map((arg) => {
    if (!arg.startsWith("--inspect")) {
      return arg;
    }
    let debugOption;
    let debugHost = "127.0.0.1";
    let debugPort = "9229";
    let match;
    if ((match = arg.match(/^(--inspect(-brk)?)$/)) !== null) {
      debugOption = match[1];
    } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+)$/)) !== null) {
      debugOption = match[1];
      if (/^\d+$/.test(match[3])) {
        debugPort = match[3];
      } else {
        debugHost = match[3];
      }
    } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+):(\d+)$/)) !== null) {
      debugOption = match[1];
      debugHost = match[3];
      debugPort = match[4];
    }
    if (debugOption && debugPort !== "0") {
      return `${debugOption}=${debugHost}:${parseInt(debugPort) + 1}`;
    }
    return arg;
  });
}
function useColor() {
  if (process2.env.NO_COLOR || process2.env.FORCE_COLOR === "0" || process2.env.FORCE_COLOR === "false")
    return false;
  if (process2.env.FORCE_COLOR || process2.env.CLICOLOR_FORCE !== void 0)
    return true;
  return void 0;
}

// node_modules/commander/index.js
var program = new Command();

// plugins/kxm-mesh/src/artifacts-exist.ts
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
function staysUnder(root, candidate) {
  const child = relative(root, candidate);
  return child === "" || !isAbsolute(child) && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}
function verifyArtifactExists(rootInput, pathInput) {
  const lexicalRoot = resolve(rootInput);
  const lexicalPath = resolve(pathInput);
  if (!staysUnder(lexicalRoot, lexicalPath)) {
    return { ok: false, error: "artifact_outside_workspace_assets", path: lexicalPath };
  }
  let realRoot;
  let realPath;
  try {
    realRoot = realpathSync(lexicalRoot);
  } catch {
    return { ok: false, error: "artifact_unreadable", path: lexicalPath };
  }
  try {
    realPath = realpathSync(lexicalPath);
  } catch {
    return { ok: false, error: "artifact_missing", path: lexicalPath };
  }
  if (!staysUnder(realRoot, realPath)) {
    return { ok: false, error: "artifact_outside_workspace_assets", path: lexicalPath };
  }
  try {
    const link = lstatSync(lexicalPath);
    if (link.isSymbolicLink()) {
      return { ok: false, error: "artifact_outside_workspace_assets", path: lexicalPath };
    }
    const artifact = statSync(realPath);
    if (!artifact.isFile()) return { ok: false, error: "artifact_not_file", path: lexicalPath };
    if (artifact.size < 1) return { ok: false, error: "artifact_empty", path: lexicalPath };
    return { ok: true, path: realPath, bytes: artifact.size };
  } catch {
    return { ok: false, error: "artifact_unreadable", path: lexicalPath };
  }
}

// plugins/kxm-mesh/src/protocol.ts
var DEFAULT_MESSAGE_TTL_MS = 24 * 60 * 6e4;
var MIN_MESSAGE_TTL_MS = 1e3;
var MAX_MESSAGE_TTL_MS = 7 * 24 * 60 * 6e4;
var DEFAULT_MESSAGE_RETENTION_MS = 7 * 24 * 60 * 6e4;
var MAX_BODY_BYTES = 256 * 1024;
var ProtocolError = class extends Error {
  statusCode;
  code;
  extras;
  constructor(statusCode, message, code = "protocol_error", extras) {
    super(message);
    this.name = "ProtocolError";
    this.statusCode = statusCode;
    this.code = code;
    if (extras) this.extras = extras;
  }
};
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function requireString(value, field, options = {}) {
  if (typeof value !== "string") {
    throw new ProtocolError(400, `${field} must be a string`);
  }
  const result = value.trim();
  if (!options.allowEmpty && result.length === 0) {
    throw new ProtocolError(400, `${field} cannot be empty`);
  }
  if (options.max !== void 0 && result.length > options.max) {
    throw new ProtocolError(400, `${field} exceeds ${options.max} characters`);
  }
  return result;
}

// plugins/kxm-mesh/src/workflow.ts
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}
function stringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return value.map((item) => item.trim());
}
function canonicalWorkflowEvidenceKey(value) {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}
function normalizeVerifiedWorkflowEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = /* @__PURE__ */ new Map();
  for (const [rawRequirement, rawSnapshots] of Object.entries(value)) {
    const requirement = canonicalWorkflowEvidenceKey(rawRequirement);
    if (!requirement || !Array.isArray(rawSnapshots)) continue;
    const snapshots = rawSnapshots.filter((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const snapshot = candidate;
      return snapshot.schema === "pi-mesh.verified-peer-evidence.v1" && typeof snapshot.messageId === "string" && typeof snapshot.producerId === "string" && typeof snapshot.producerName === "string" && snapshot.status === "replied" && typeof snapshot.requestSha256 === "string" && typeof snapshot.replySha256 === "string" && typeof snapshot.createdAt === "string" && typeof snapshot.replyCreatedAt === "string" && typeof snapshot.repliedAt === "string" && typeof snapshot.verifiedAt === "string" && snapshot.context?.schema === "pi-mesh.workflow-message-context.v1";
    });
    if (snapshots.length) result.set(requirement, snapshots);
  }
  return Object.fromEntries(result);
}
function parseWorkflowEvidencePolicies(value, stageId, requiredEvidence, workflowId, targetName, warn) {
  if (value === void 0) return void 0;
  const rawPolicies = object(value, `stage ${stageId} evidencePolicies`);
  const policies = /* @__PURE__ */ new Map();
  for (const [rawRequirement, rawPolicy] of Object.entries(rawPolicies)) {
    const requirementKey = canonicalWorkflowEvidenceKey(
      requireString(rawRequirement, `stage ${stageId} evidencePolicies requirement`, { max: 128 })
    );
    if (!requiredEvidence.includes(requirementKey)) {
      throw new Error(`stage ${stageId} evidence policy ${requirementKey} must match requiredEvidence`);
    }
    if (policies.has(requirementKey)) {
      throw new Error(`stage ${stageId} evidencePolicies keys must be unique after normalization`);
    }
    const policy = object(rawPolicy, `stage ${stageId} evidencePolicies.${requirementKey}`);
    const supportedPolicyFields = /* @__PURE__ */ new Set([
      "kind",
      "minProducers",
      "eligibleAgents",
      "acceptedStatuses",
      "degradation"
    ]);
    const unsupportedPolicyFields = Object.keys(policy).filter((field) => !supportedPolicyFields.has(field));
    if (unsupportedPolicyFields.length) {
      throw new Error(
        `stage ${stageId} evidencePolicies.${requirementKey} contains unsupported fields: ${unsupportedPolicyFields.join(", ")}`
      );
    }
    if (policy.kind !== "peer-reply") {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.kind must be peer-reply`);
    }
    const minProducers = policy.minProducers;
    if (!Number.isInteger(minProducers) || minProducers < 1 || minProducers > 8) {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.minProducers must be an integer between 1 and 8`);
    }
    const eligibleAgents = stringArray(
      policy.eligibleAgents,
      `stage ${stageId} evidencePolicies.${requirementKey}.eligibleAgents`
    );
    if (eligibleAgents.length < 1 || eligibleAgents.length > 16) {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.eligibleAgents must contain between 1 and 16 selectors`);
    }
    const normalizedSelectors = eligibleAgents.map((selector) => selector.toLowerCase());
    if (new Set(normalizedSelectors).size !== normalizedSelectors.length) {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.eligibleAgents must be unique`);
    }
    if (normalizedSelectors.includes(targetName)) {
      throw new Error(
        `workflow ${workflowId} stage ${stageId} evidencePolicies.${requirementKey}.eligibleAgents must not include the workflow target ${targetName}: the target cannot produce peer evidence for its own run`
      );
    }
    if (minProducers > normalizedSelectors.length) {
      throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.minProducers exceeds eligibleAgents`);
    }
    if (policy.acceptedStatuses !== void 0) {
      const statuses = stringArray(
        policy.acceptedStatuses,
        `stage ${stageId} evidencePolicies.${requirementKey}.acceptedStatuses`
      );
      if (statuses.length !== 1 || statuses[0] !== "replied") {
        throw new Error(`stage ${stageId} evidencePolicies.${requirementKey}.acceptedStatuses must be ["replied"]`);
      }
    }
    let degradation;
    if (policy.degradation !== void 0) {
      const rawDegradation = object(
        policy.degradation,
        `stage ${stageId} evidencePolicies.${requirementKey}.degradation`
      );
      const unsupportedDegradationFields = Object.keys(rawDegradation).filter((field) => field !== "minProducers");
      if (unsupportedDegradationFields.length) {
        throw new Error(
          `stage ${stageId} evidencePolicies.${requirementKey}.degradation contains unsupported fields: ${unsupportedDegradationFields.join(", ")}`
        );
      }
      const degradedMin = rawDegradation.minProducers;
      if (!Number.isInteger(degradedMin) || degradedMin < 1 || degradedMin >= minProducers) {
        throw new Error(
          `stage ${stageId} evidencePolicies.${requirementKey}.degradation.minProducers must be at least 1 and lower than minProducers`
        );
      }
      degradation = { minProducers: degradedMin };
      if (degradation.minProducers < 2) {
        warn(
          `workflow ${workflowId} stage ${stageId} evidence policy ${requirementKey}: degradation.minProducers is ${degradation.minProducers} (< 2); a single producer can satisfy the degraded peer-reply quorum`
        );
      }
    }
    policies.set(requirementKey, {
      kind: "peer-reply",
      minProducers,
      eligibleAgents,
      acceptedStatuses: ["replied"],
      ...degradation ? { degradation } : {}
    });
  }
  return policies.size ? Object.fromEntries(policies) : void 0;
}
function parseWorkflowDefinitions(raw, environment = process.env, onWarning) {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("PI_MESH_WEBHOOK_WORKFLOWS must be a JSON array");
  const warn = (message) => {
    onWarning?.(message);
  };
  const ids = /* @__PURE__ */ new Set();
  return parsed.map((entry, definitionIndex) => {
    const value = object(entry, `workflow ${definitionIndex}`);
    const id = requireString(value.id, "workflow.id", { max: 64 });
    if (ids.has(id)) throw new Error(`duplicate workflow id: ${id}`);
    ids.add(id);
    const source = value.source ?? "generic";
    if (source !== "jira" && source !== "github" && source !== "generic") {
      throw new Error(`workflow ${id} source must be jira, github, or generic`);
    }
    const delivery = value.delivery ?? "followUp";
    if (delivery !== "steer" && delivery !== "followUp") {
      throw new Error(`workflow ${id} delivery must be steer or followUp`);
    }
    const secretEnv = value.secretEnv === void 0 ? void 0 : requireString(value.secretEnv, "workflow.secretEnv", { max: 128 });
    if (value.secret !== void 0 && secretEnv) {
      throw new Error(`workflow ${id} must configure only one of secret or secretEnv`);
    }
    const secret = requireString(secretEnv ? environment[secretEnv] : value.secret, "workflow.secret", { max: 512 });
    if (secret.length < 16) throw new Error(`workflow ${id} secret must contain at least 16 characters`);
    const signalSecretEnv = value.signalSecretEnv === void 0 ? void 0 : requireString(value.signalSecretEnv, "workflow.signalSecretEnv", { max: 128 });
    if (value.signalSecret !== void 0 && signalSecretEnv) {
      throw new Error(`workflow ${id} must configure only one of signalSecret or signalSecretEnv`);
    }
    const signalSecret = signalSecretEnv ? requireString(environment[signalSecretEnv], "workflow.signalSecret", { max: 512 }) : value.signalSecret === void 0 ? void 0 : requireString(value.signalSecret, "workflow.signalSecret", { max: 512 });
    if (signalSecret && signalSecret.length < 16) {
      throw new Error(`workflow ${id} signalSecret must contain at least 16 characters`);
    }
    const target = requireString(value.target, "workflow.target", { max: 80 });
    const targetName = target.toLowerCase();
    if (!Array.isArray(value.stages) || value.stages.length === 0 || value.stages.length > 32) {
      throw new Error(`workflow ${id} must define between 1 and 32 stages`);
    }
    const stageIds = /* @__PURE__ */ new Set();
    const stages = value.stages.map((stageEntry, stageIndex) => {
      const stage = object(stageEntry, `workflow ${id} stage ${stageIndex}`);
      const stageId = requireString(stage.id, "stage.id", { max: 64 });
      if (stageIds.has(stageId)) throw new Error(`duplicate stage id ${stageId} in workflow ${id}`);
      stageIds.add(stageId);
      const maxAttempts = stage.maxAttempts ?? 3;
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
        throw new Error(`stage ${stageId} maxAttempts must be an integer between 1 and 20`);
      }
      const area = stage.area ? requireString(stage.area, "stage.area", { max: 24 }) : void 0;
      if (area && !["harness", "gates", "implementation", "workflow", "documentation", "security", "other"].includes(area)) {
        throw new Error(`stage ${stageId} area is invalid`);
      }
      const requiredEvidence = stringArray(stage.requiredEvidence ?? [], "stage.requiredEvidence").map((requirement, requirementIndex) => canonicalWorkflowEvidenceKey(
        requireString(requirement, `stage.requiredEvidence[${requirementIndex}]`, { max: 128 })
      ));
      if (requiredEvidence.length > 32) throw new Error(`stage ${stageId} may require at most 32 evidence keys`);
      if (new Set(requiredEvidence).size !== requiredEvidence.length) {
        throw new Error(`stage ${stageId} requiredEvidence keys must be unique`);
      }
      const evidencePolicies = parseWorkflowEvidencePolicies(
        stage.evidencePolicies,
        stageId,
        requiredEvidence,
        id,
        targetName,
        warn
      );
      return {
        id: stageId,
        label: requireString(stage.label ?? stageId, "stage.label", { max: 128 }),
        instructions: requireString(stage.instructions, "stage.instructions", { max: 4e3 }),
        requiredEvidence,
        maxAttempts,
        ...area ? { area } : {},
        ...evidencePolicies ? { evidencePolicies } : {}
      };
    });
    let filter;
    if (value.filter !== void 0) {
      const candidate = object(value.filter, `workflow ${id} filter`);
      filter = {
        path: requireString(candidate.path, "filter.path", { max: 256 }),
        equals: requireString(candidate.equals, "filter.equals", { max: 512 })
      };
    }
    if (value.ttlMs !== void 0 && (!Number.isInteger(value.ttlMs) || value.ttlMs < MIN_MESSAGE_TTL_MS || value.ttlMs > MAX_MESSAGE_TTL_MS)) {
      throw new Error(`workflow ${id} ttlMs must be an integer between ${MIN_MESSAGE_TTL_MS} and ${MAX_MESSAGE_TTL_MS}`);
    }
    return {
      id,
      source,
      project: requireString(value.project, "workflow.project", { max: 128 }),
      target,
      secret,
      ...signalSecret ? { signalSecret } : {},
      ...value.event ? { event: requireString(value.event, "workflow.event", { max: 128 }) } : {},
      ...filter ? { filter } : {},
      delivery,
      ...value.ttlMs !== void 0 ? { ttlMs: value.ttlMs } : {},
      promptTemplate: requireString(value.promptTemplate, "workflow.promptTemplate", { max: 2e4 }),
      stages
    };
  });
}

// plugins/kxm-mesh/src/github-watch.ts
import { createHmac, randomUUID } from "node:crypto";

// plugins/kxm-mesh/src/redact.ts
var SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /\bPI_MESH_[A-Z0-9_]*(TOKEN|SECRET|KEY)[A-Z0-9_]*=\S+/gi,
  /\b(GITHUB_TOKEN|GH_TOKEN|PI_MESH_AUTH_TOKEN|PI_MESH_WORKFLOW_SIGNAL_SECRET)=\S+/gi,
  /\b[A-Fa-f0-9]{64}\b/g
];
function redactSecrets(value) {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[redacted]");
  }
  return result;
}
function redactStringList(values, maxItems = 32) {
  return values.slice(0, maxItems).map((value) => redactSecrets(value).slice(0, 500));
}

// plugins/kxm-mesh/src/github-watch.ts
async function fetchWithTimeout(fetchImpl, input, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
function requiredToken(token) {
  const value = token?.trim();
  return value || void 0;
}
var FAILED_CONCLUSIONS = /* @__PURE__ */ new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure"
]);
var SUCCESS_CONCLUSIONS = /* @__PURE__ */ new Set(["success"]);
var CHECK_RUNS_PER_PAGE = 100;
var MAX_CHECK_RUN_PAGES = 100;
function mapCheckConclusion(runs, required = []) {
  const names = required.length > 0 ? required : [...new Set(runs.map((run) => run.name))];
  const interesting = names.map((name) => runs.find((run) => run.name === name));
  const evidence = Object.fromEntries(interesting.slice(0, 32).map((run, index) => {
    const name = names[index] ?? "unknown";
    const conclusion = run?.conclusion ?? run?.status ?? "missing";
    const url = run?.html_url ? ` url:${run.html_url}` : "";
    const completed = run?.completed_at ? ` at:${run.completed_at}` : "";
    return [`github.check:${name}`, redactSecrets(`conclusion:${conclusion}${url}${completed}`).slice(0, 500)];
  }));
  if (names.length === 0 || interesting.some((run) => !run || run.status !== "completed")) {
    return { status: "pending", evidence };
  }
  if (interesting.some((run) => FAILED_CONCLUSIONS.has(run?.conclusion ?? ""))) {
    return { status: "failed", evidence };
  }
  if (interesting.every((run) => SUCCESS_CONCLUSIONS.has(run?.conclusion ?? ""))) {
    return { status: "passed", evidence };
  }
  return { status: "pending", evidence };
}
async function postWorkflowSignal(input) {
  const body = JSON.stringify({ status: input.status, summary: input.summary, evidence: input.evidence });
  const signature = `sha256=${createHmac("sha256", input.signalSecret).update(body).digest("hex")}`;
  const endpoint = [
    input.serverUrl.replace(/\/$/, ""),
    "v1/webhooks",
    encodeURIComponent(input.definitionId),
    "runs",
    encodeURIComponent(input.runId),
    "signals",
    encodeURIComponent(input.signalKey)
  ].join("/");
  const response = await fetchWithTimeout(input.fetchImpl ?? fetch, endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-mesh-delivery-id": input.deliveryId
    },
    body
  }, input.timeoutMs ?? 15e3);
  const text = await response.text();
  let duplicate = false;
  try {
    const parsed = JSON.parse(text);
    duplicate = parsed.duplicate === true;
  } catch {
  }
  if (!response.ok && response.status !== 200) {
    throw new Error(`signal_http_${response.status}`);
  }
  return { httpStatus: response.status, duplicate };
}
async function watchGithubChecks(input) {
  const token = requiredToken(input.token);
  if (!token) {
    return { exitCode: 1, posted: false, skipped: true, summary: "github_auth_unavailable", evidence: {} };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms) => new Promise((resolve4) => setTimeout(resolve4, ms)));
  const deadline = now() + input.timeoutMs;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "pi-mesh-github-watch"
  };
  const contextEvidence = {
    "workflow.run": input.runId,
    "workflow.stage": input.stageId,
    "workflow.signal": input.signalKey
  };
  const explicitDeliveryId = input.deliveryId?.trim();
  const deliveryGeneration = randomUUID();
  let deliveryId = explicitDeliveryId || `github-watch:${deliveryGeneration}:pr-${input.pr}`;
  const deliver = async (status, summary, evidence) => {
    const boundedEvidence = Object.fromEntries(Object.entries({ ...contextEvidence, ...evidence }).slice(0, 64));
    if (input.dryRun) return { exitCode: status === "failed" && summary === "github_watch_timeout" ? 4 : 0, posted: false, status, summary, evidence: boundedEvidence, deliveryId };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const posted = await postWorkflowSignal({ serverUrl: input.serverUrl, definitionId: input.definitionId, signalSecret: input.signalSecret, runId: input.runId, signalKey: input.signalKey, status, summary, evidence: boundedEvidence, deliveryId, timeoutMs: Math.min(15e3, Math.max(1e3, input.intervalMs)), fetchImpl });
        return { exitCode: status === "failed" && summary === "github_watch_timeout" ? 4 : 0, posted: true, duplicate: posted.duplicate, status, summary, evidence: boundedEvidence, deliveryId };
      } catch (error) {
        const message = error instanceof Error ? error.message : "signal_failed";
        if (/signal_http_(404|409)\b/.test(message)) return { exitCode: 1, posted: false, summary: "workflow_not_waiting", evidence: boundedEvidence, deliveryId };
        const transient = /signal_http_(429|5\d\d)\b/.test(message) || message === "signal_failed" || /abort|timeout|fetch/i.test(message);
        if (!transient || attempt === 3) return { exitCode: 1, posted: false, summary: "signal_failed", evidence: boundedEvidence, deliveryId };
        await sleep(Math.min(250 * 2 ** (attempt - 1), 1e3));
      }
    }
    return { exitCode: 1, posted: false, summary: "signal_failed", evidence: boundedEvidence, deliveryId };
  };
  const githubGet = async (url) => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const remaining = deadline - now();
      if (remaining <= 0) return void 0;
      try {
        const response = await fetchWithTimeout(fetchImpl, url, { headers }, Math.min(15e3, remaining));
        if (response.status !== 429 && response.status < 500) return response;
        if (attempt === 3) return response;
      } catch {
        if (attempt === 3 || now() >= deadline) return void 0;
      }
      await sleep(Math.min(250 * 2 ** (attempt - 1), Math.max(1, deadline - now())));
    }
    return void 0;
  };
  const prResponse = await githubGet(`https://api.github.com/repos/${input.repo}/pulls/${input.pr}`);
  if (!prResponse) return deliver("failed", "github_watch_timeout", {});
  if (!prResponse.ok) {
    return { exitCode: 1, posted: false, summary: "github_pr_unavailable", evidence: { "github.http": String(prResponse.status) } };
  }
  const pull = await prResponse.json();
  const headSha = pull.head?.sha;
  if (!headSha) {
    return { exitCode: 1, posted: false, summary: "github_head_unavailable", evidence: {} };
  }
  if (!explicitDeliveryId) deliveryId = `github-watch:${deliveryGeneration}:${headSha.slice(0, 40)}`;
  let lastEvidence = {};
  while (now() <= deadline) {
    const checkRuns = [];
    for (let page = 1; page <= MAX_CHECK_RUN_PAGES; page += 1) {
      const checksUrl = new URL(`https://api.github.com/repos/${input.repo}/commits/${headSha}/check-runs`);
      checksUrl.searchParams.set("per_page", String(CHECK_RUNS_PER_PAGE));
      checksUrl.searchParams.set("page", String(page));
      const checksResponse = await githubGet(checksUrl.toString());
      if (!checksResponse) return deliver("failed", "github_watch_timeout", lastEvidence);
      if (!checksResponse.ok) {
        return { exitCode: 1, posted: false, summary: "github_checks_unavailable", evidence: { "github.http": String(checksResponse.status) } };
      }
      const payload = await checksResponse.json();
      const pageRuns = Array.isArray(payload.check_runs) ? payload.check_runs : [];
      checkRuns.push(...pageRuns);
      const totalCount = Number.isInteger(payload.total_count) && payload.total_count >= 0 ? payload.total_count : void 0;
      const complete = totalCount === void 0 ? pageRuns.length < CHECK_RUNS_PER_PAGE : checkRuns.length >= totalCount;
      if (complete) break;
      if (pageRuns.length === 0 || page === MAX_CHECK_RUN_PAGES) {
        return {
          exitCode: 1,
          posted: false,
          summary: "github_checks_unavailable",
          evidence: { "github.pagination": pageRuns.length === 0 ? "incomplete" : "limit_exceeded" }
        };
      }
    }
    const mapped = mapCheckConclusion(checkRuns, input.required ?? []);
    lastEvidence = mapped.evidence;
    if (mapped.status !== "pending") {
      const summary = mapped.status === "passed" ? "required GitHub checks passed" : "required GitHub checks failed";
      return deliver(mapped.status, summary, mapped.evidence);
    }
    if (now() + input.intervalMs > deadline) break;
    await sleep(input.intervalMs);
  }
  return deliver("failed", "github_watch_timeout", lastEvidence);
}

// plugins/kxm-mesh/src/retrospective.ts
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve as resolve2 } from "node:path";
var MAX_RETROSPECTIVE_ENTRIES = 500;
var SAFE_RUN_ID = /^run_[A-Za-z0-9_-]{1,120}$/;
function durationMs(startedAt, completedAt) {
  if (!startedAt || !completedAt) return void 0;
  const value = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(value) && value >= 0 ? value : void 0;
}
function increment(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}
function classFromEvidence(evidence) {
  const match = evidence.find((item) => item.startsWith("class:"));
  return match?.slice("class:".length) || "unknown";
}
function buildEvidenceAudit(run) {
  const audit = [];
  for (const stage of run.stages) {
    const verifiedEvidence = normalizeVerifiedWorkflowEvidence(stage.verifiedEvidence);
    const degradedRequirements = new Set(
      (stage.degradedRequirements ?? []).map(canonicalWorkflowEvidenceKey)
    );
    const policies = Object.entries(stage.resolvedEvidencePolicies ?? {}).sort(([left], [right]) => left.localeCompare(right));
    for (const [rawRequirement, policy] of policies) {
      const requirementKey = canonicalWorkflowEvidenceKey(rawRequirement);
      const attempt = stage.status === "passed" || stage.status === "failed" ? Math.max(1, stage.attempts) : stage.attempts + 1;
      const verifiedMessages = [...verifiedEvidence[requirementKey] ?? []].filter((snapshot) => snapshot.context.runId === run.id && snapshot.context.stageId === stage.id && snapshot.context.requirementKey === requirementKey && snapshot.context.attempt === attempt).sort((left, right) => left.messageId.localeCompare(right.messageId)).map((snapshot) => ({
        schema: snapshot.schema,
        messageId: snapshot.messageId,
        producerId: snapshot.producerId,
        producerName: snapshot.producerName,
        context: {
          schema: snapshot.context.schema,
          runId: snapshot.context.runId,
          stageId: snapshot.context.stageId,
          requirementKey: snapshot.context.requirementKey,
          attempt: snapshot.context.attempt
        },
        status: snapshot.status,
        hashes: {
          requestSha256: snapshot.requestSha256,
          replySha256: snapshot.replySha256
        },
        timestamps: {
          createdAt: snapshot.createdAt,
          replyCreatedAt: snapshot.replyCreatedAt,
          repliedAt: snapshot.repliedAt,
          verifiedAt: snapshot.verifiedAt
        }
      }));
      const degradationApprovals = (stage.degradationApprovals ?? []).filter((approval) => approval.schema === "pi-mesh.workflow-degradation-approval.v1" && approval.requirementKey === requirementKey && approval.attempt === attempt).sort((left, right) => left.attempt - right.attempt || left.approvedAt.localeCompare(right.approvedAt) || left.id.localeCompare(right.id)).map((approval) => ({
        schema: approval.schema,
        id: approval.id,
        requirementKey: approval.requirementKey,
        attempt: approval.attempt,
        policyMinProducers: approval.policyMinProducers,
        approvedMinProducers: approval.approvedMinProducers,
        approvedBy: approval.approvedBy,
        reason: redactSecrets(approval.reason).replace(/\s+/gu, " ").trim(),
        approvedAt: approval.approvedAt
      }));
      const degraded = Boolean(stage.degraded && degradedRequirements.has(requirementKey));
      const appliedApproval = degradationApprovals.at(-1);
      audit.push({
        stageId: stage.id,
        requirementKey,
        attempt,
        policy: {
          kind: policy.kind,
          minProducers: policy.minProducers,
          effectiveMinProducers: appliedApproval?.approvedMinProducers ?? policy.minProducers,
          acceptedStatuses: ["replied"]
        },
        eligibleProducers: [...policy.eligibleProducers].sort((left, right) => left.id.localeCompare(right.id) || left.name.localeCompare(right.name)).map((producer) => ({ id: producer.id, name: producer.name })),
        verifiedProducerIds: [...new Set(verifiedMessages.map((snapshot) => snapshot.producerId))].sort(),
        verifiedMessages,
        degraded,
        degradationApprovals
      });
    }
  }
  return audit;
}
function buildRetrospective(run, journal, exportedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!SAFE_RUN_ID.test(run.id)) throw new Error("invalid retrospective run id");
  const entries = journal.filter((entry) => entry.runId === run.id).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).slice(-MAX_RETROSPECTIVE_ENTRIES).map((entry) => ({
    id: entry.id,
    category: entry.category,
    area: entry.area,
    severity: entry.severity,
    summary: redactSecrets(entry.summary),
    evidence: redactStringList(entry.evidence),
    relatedEntryIds: entry.relatedEntryIds.slice(0, 16),
    createdAt: entry.createdAt
  }));
  const byCategory = {};
  const byArea = {};
  const byClass = {};
  for (const entry of entries) {
    increment(byCategory, entry.category);
    increment(byArea, entry.area);
    increment(byClass, classFromEvidence(entry.evidence));
  }
  const recurringErrorClasses = Object.entries(byClass).map(([errorClass, count]) => ({ class: errorClass, count })).sort((left, right) => right.count - left.count || left.class.localeCompare(right.class));
  const resolvedContradictions = new Set(entries.filter((entry) => entry.category === "decision" || entry.category === "lesson").flatMap((entry) => entry.relatedEntryIds));
  const openContradictions = entries.filter((entry) => entry.category === "contradiction" && !resolvedContradictions.has(entry.id)).map((entry) => ({ id: entry.id, summary: entry.summary, area: entry.area }));
  const decisions = entries.filter((entry) => entry.category === "decision").map((entry) => ({ id: entry.id, summary: entry.summary, area: entry.area }));
  const proposedImprovements = entries.filter((entry) => entry.category === "lesson" || entry.category === "error").slice(0, 12).map((entry) => ({
    area: entry.area,
    summary: entry.summary,
    successMeasure: "reduce recurrence of this class in the next comparable run",
    status: "proposed"
  }));
  const evidenceAudit = buildEvidenceAudit(run);
  const degradedStageIds = run.stages.filter((stage) => stage.degraded).map((stage) => stage.id);
  return {
    schema: "pi-mesh.retrospective.v1",
    runId: run.id,
    definitionId: run.definitionId,
    status: run.status,
    exportedAt,
    reviewDecision: "proposed",
    stages: run.stages.map((stage) => {
      const elapsed = durationMs(stage.startedAt, stage.completedAt);
      return { id: stage.id, ...stage.area ? { area: stage.area } : {}, status: stage.status, attempts: stage.attempts, ...stage.startedAt ? { startedAt: stage.startedAt } : {}, ...stage.completedAt ? { completedAt: stage.completedAt } : {}, ...elapsed !== void 0 ? { durationMs: elapsed } : {}, ...stage.updatedAt ? { updatedAt: stage.updatedAt } : {}, ...stage.summary ? { summary: redactSecrets(stage.summary) } : {} };
    }),
    counts: { byCategory, byArea, byClass },
    openContradictions,
    decisions,
    recurringErrorClasses,
    entries,
    proposedImprovements,
    ...evidenceAudit.length ? { evidenceAudit } : {},
    ...degradedStageIds.length ? { degradedStageIds } : {}
  };
}
function renderRetrospectiveMarkdown(doc) {
  const stageRows = doc.stages.map((stage) => `| ${stage.id} | ${stage.area ?? ""} | ${stage.status} | ${stage.attempts} | ${stage.durationMs ?? ""} |`).join("\n");
  const contradictionRows = doc.openContradictions.map((entry) => `- ${entry.id} (${entry.area}): ${entry.summary}`).join("\n") || "- none";
  const decisionRows = doc.decisions.map((entry) => `- ${entry.id} (${entry.area}): ${entry.summary}`).join("\n") || "- none";
  const classRows = doc.recurringErrorClasses.map((entry) => `- ${entry.class}: ${entry.count}`).join("\n") || "- none";
  const entryRows = doc.entries.map((entry) => {
    const related = entry.relatedEntryIds.length > 0 ? `; related: ${entry.relatedEntryIds.join(", ")}` : "";
    const evidence = entry.evidence.length > 0 ? `; evidence: ${entry.evidence.join(", ")}` : "";
    return `- ${entry.id} [${entry.category}/${entry.area}/${entry.severity}]: ${entry.summary}${related}${evidence}`;
  }).join("\n") || "- none";
  const evidenceAuditRows = (doc.evidenceAudit ?? []).flatMap((audit) => {
    const producerNames = audit.eligibleProducers.map((producer) => `${producer.name} (${producer.id})`).join(", ") || "none";
    const verified = audit.verifiedMessages.length ? audit.verifiedMessages.map((snapshot) => `  - ${snapshot.messageId}: producer ${snapshot.producerName} (${snapshot.producerId}), attempt ${snapshot.context.attempt}, request ${snapshot.hashes.requestSha256}, reply ${snapshot.hashes.replySha256}, replied ${snapshot.timestamps.repliedAt}, verified ${snapshot.timestamps.verifiedAt}`) : ["  - no verified messages"];
    const approvals = audit.degradationApprovals.map((approval) => `  - approval ${approval.id}: attempt ${approval.attempt}, ${approval.policyMinProducers} -> ${approval.approvedMinProducers} producers, ${approval.approvedBy}, ${approval.approvedAt}; reason: ${approval.reason}`);
    return [
      `- ${audit.stageId} / ${audit.requirementKey} / attempt ${audit.attempt}: ${audit.verifiedProducerIds.length}/${audit.policy.effectiveMinProducers} verified producers; policy minimum ${audit.policy.minProducers}; degraded: ${audit.degraded}`,
      `  - eligible: ${producerNames}`,
      ...verified,
      ...approvals.length ? ["  - degradation approvals:", ...approvals] : []
    ];
  });
  return [
    `# Workflow retrospective ${doc.runId}`,
    "",
    `- Definition: ${doc.definitionId}`,
    `- Status: ${doc.status}`,
    `- Exported: ${doc.exportedAt}`,
    `- Review decision: ${doc.reviewDecision}`,
    "",
    "## Stages",
    "",
    "| id | area | status | attempts | duration ms |",
    "|---|---|---|---|---|",
    stageRows,
    "",
    "## Decisions",
    "",
    decisionRows,
    "",
    "## Open contradictions",
    "",
    contradictionRows,
    "",
    "## Recurring error classes",
    "",
    classRows,
    "",
    "## Bounded journal evidence",
    "",
    entryRows,
    "",
    ...doc.evidenceAudit?.length ? [
      "## Peer-evidence audit",
      "",
      "This section contains immutable provenance metadata and content hashes only; prompt and reply bodies are excluded.",
      "",
      ...evidenceAuditRows,
      ""
    ] : [],
    "## Proposed improvements",
    "",
    ...doc.proposedImprovements.map((item) => `- [${item.status}] (${item.area}) ${item.summary}`),
    "",
    "Proposed improvements are evidence, not policy. Do not apply them until an explicit review decision.",
    ""
  ].join("\n");
}
function writeRetrospective(outDir, doc) {
  if (!SAFE_RUN_ID.test(doc.runId)) throw new Error("invalid retrospective run id");
  mkdirSync(outDir, { recursive: true });
  const root = resolve2(outDir);
  const jsonPath = resolve2(root, `${doc.runId}.json`);
  const mdPath = resolve2(root, `${doc.runId}.md`);
  const prefix = `${root}${process.platform === "win32" ? "\\" : "/"}`;
  if (!jsonPath.startsWith(prefix) || !mdPath.startsWith(prefix)) throw new Error("retrospective path escaped output directory");
  const jsonTmp = `${jsonPath}.tmp`;
  const mdTmp = `${mdPath}.tmp`;
  writeFileSync(jsonTmp, `${JSON.stringify(doc, null, 2)}
`, { encoding: "utf8", mode: 384 });
  writeFileSync(mdTmp, renderRetrospectiveMarkdown(doc), { encoding: "utf8", mode: 384 });
  renameSync(jsonTmp, jsonPath);
  renameSync(mdTmp, mdPath);
  return { jsonPath, mdPath };
}

// plugins/kxm-mesh/src/envelope.ts
var WORKER_SCHEMA = "kxm.worker.v1";
var WORKER_RESULT_SCHEMA = "kxm.worker-result.v1";
function agentWorker(input) {
  return {
    schema: WORKER_SCHEMA,
    kind: "agent",
    driver: "ai",
    name: input.name,
    ...input.project ? { project: input.project } : {},
    ...input.purpose ? { purpose: input.purpose } : {},
    ...input.model ? { model: input.model } : {},
    ...input.thinking ? { thinking: input.thinking } : {}
  };
}
function gateWorker(input) {
  return {
    schema: WORKER_SCHEMA,
    kind: "gate",
    driver: "code",
    name: input.name,
    ...input.project ? { project: input.project } : {},
    ...input.purpose ? { purpose: input.purpose } : {}
  };
}
function workerResult(worker, payload) {
  const { summary, outcome, createdAt, ...rest } = payload;
  if (outcome === "passed" && payload.ok === false) {
    throw new Error('workerResult outcome contradicts ok: "passed" requires ok: true');
  }
  if (outcome === "failed" && payload.ok === true) {
    throw new Error('workerResult outcome contradicts ok: "failed" requires ok: false');
  }
  return {
    ...rest,
    schema: WORKER_RESULT_SCHEMA,
    worker,
    createdAt: createdAt ?? nowIso(),
    outcome: outcome ?? (payload.ok ? "passed" : "failed"),
    summary
  };
}

// plugins/kxm-mesh/src/telemetry.ts
import { appendFileSync, mkdirSync as mkdirSync2, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
var TELEMETRY_SCHEMA = "kxm.telemetry.v1";
function inferImprovementTarget(input) {
  const explicit = input.env?.KXM_IMPROVE_TARGET?.trim();
  if (explicit === "cli" || explicit === "project") return explicit;
  const project = (input.project ?? input.env?.PI_MESH_PROJECT ?? "").toLowerCase();
  const workflowId = (input.workflowId ?? "").toLowerCase();
  if (project === "payk12" || workflowId.startsWith("factory-")) return "project";
  return "cli";
}
function appendTelemetry(path5, event) {
  mkdirSync2(dirname(path5), { recursive: true });
  appendFileSync(path5, `${JSON.stringify(event)}
`, { encoding: "utf8", mode: 384 });
}
function readTelemetry(path5) {
  try {
    const raw = readFileSync(path5, "utf8");
    const events = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.schema === TELEMETRY_SCHEMA) events.push(parsed);
      } catch {
      }
    }
    return events;
  } catch {
    return [];
  }
}
function telemetryPath(logsDir) {
  return join(logsDir, "telemetry.jsonl");
}
function makeTelemetryEvent(input) {
  return {
    schema: TELEMETRY_SCHEMA,
    recordedAt: nowIso(),
    host: input.host ?? "local",
    target: input.target,
    envelope: input.envelope,
    ...input.sessionId ? { sessionId: input.sessionId } : {}
  };
}

// plugins/kxm-mesh/src/session.ts
import { existsSync, mkdirSync as mkdirSync3, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
var SESSION_SCHEMA = "kxm.session.v1";
var SessionConfigError = class extends Error {
  code = "session_config_invalid";
  constructor(message) {
    super(message);
    this.name = "SessionConfigError";
  }
};
function workflowAssetDirs(assetsDir, workflowId) {
  const root = join2(assetsDir, "workflows", workflowId);
  return [root, join2(root, "inputs"), join2(root, "outputs"), join2(root, "generated")];
}
function sessionAssetDirs(assetsDir, sessionId) {
  const root = join2(assetsDir, "sessions", sessionId);
  return [root, join2(root, "inputs"), join2(root, "outputs")];
}
function standardAssetDirs(assetsDir) {
  return [
    join2(assetsDir, "retrospectives"),
    join2(assetsDir, "workflows"),
    join2(assetsDir, "sessions"),
    join2(assetsDir, "improvements"),
    join2(assetsDir, "generated")
  ];
}
function rosterNames(configDir) {
  return [...loadRosterMap(configDir).values()].map((row) => String(row.name));
}
function loadNamedWorkers(configDir, names, project) {
  const byName = loadRosterMap(configDir);
  return names.map((name) => {
    const trimmed = name.trim();
    const row = byName.get(trimmed.toLowerCase());
    if (!row) {
      throw new SessionConfigError(
        `unknown worker name in session roster: ${trimmed} (not present in agents.json or gates.json)`
      );
    }
    return workerFromRosterRow(trimmed, row, project);
  });
}
function workerFromRosterRow(name, row, project) {
  const kind = row.kind;
  const driver = row.driver;
  if (kind !== void 0 && kind !== "agent" && kind !== "gate") {
    throw new SessionConfigError(`roster entry ${name} has invalid kind: ${JSON.stringify(kind)}`);
  }
  if (driver !== void 0 && driver !== "ai" && driver !== "code") {
    throw new SessionConfigError(`roster entry ${name} has invalid driver: ${JSON.stringify(driver)}`);
  }
  if (kind === "agent" && driver === "code" || kind === "gate" && driver === "ai") {
    throw new SessionConfigError(
      `roster entry ${name} has kind/driver mismatch: kind=${String(kind)} driver=${String(driver)}`
    );
  }
  if (kind === "gate" || driver === "code") {
    return gateWorker({
      name,
      ...project ? { project } : {},
      ...typeof row.purpose === "string" ? { purpose: row.purpose } : {}
    });
  }
  return agentWorker({
    name,
    ...project ? { project } : {},
    ...typeof row.purpose === "string" ? { purpose: row.purpose } : {},
    ...typeof row.model === "string" ? { model: row.model } : {},
    ...typeof row.thinking === "string" ? { thinking: row.thinking } : {}
  });
}
function loadRosterMap(configDir) {
  const byName = /* @__PURE__ */ new Map();
  for (const [file, key] of [["agents.json", "agents"], ["gates.json", "gates"]]) {
    const path5 = join2(configDir, file);
    for (const row of loadRoster(path5, key)) {
      const name = String(row.name).trim();
      const lowered = name.toLowerCase();
      if (byName.has(lowered)) {
        throw new SessionConfigError(`duplicate worker name ${name} across roster files (${file} and an earlier roster)`);
      }
      void workerFromRosterRow(name, row);
      byName.set(lowered, row);
    }
  }
  return byName;
}
function loadRoster(path5, key) {
  if (!existsSync(path5)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync2(path5, "utf8"));
  } catch (error) {
    throw new SessionConfigError(
      `${key} roster at ${path5} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SessionConfigError(`${key} roster at ${path5} must be a JSON object`);
  }
  const list = parsed[key];
  if (!Array.isArray(list)) {
    throw new SessionConfigError(`${key} roster at ${path5} must contain a "${key}" array`);
  }
  return list.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new SessionConfigError(`${key} roster entry ${index} at ${path5} must be an object`);
    }
    const record = row;
    if (typeof record.name !== "string" || !record.name.trim()) {
      throw new SessionConfigError(`${key} roster entry ${index} at ${path5} must have a non-empty name`);
    }
    return record;
  });
}
function createSession(input) {
  const assetDir = input.mode === "workflow" && input.workflowId ? join2("assets", "workflows", input.workflowId) : join2("assets", "sessions", input.id);
  return {
    schema: SESSION_SCHEMA,
    id: input.id,
    host: input.host,
    mode: input.mode,
    workers: input.workers,
    createdAt: nowIso(),
    assetDir,
    ...input.workflowId ? { workflowId: input.workflowId } : {}
  };
}
function writeSession(assetsDir, session, dryRun = false) {
  const dir = join2(assetsDir, "sessions", session.id);
  const path5 = join2(dir, "session.json");
  if (!dryRun) {
    mkdirSync3(dir, { recursive: true });
    writeFileSync2(path5, `${JSON.stringify(session, null, 2)}
`, { encoding: "utf8" });
  }
  return path5;
}

// plugins/kxm-mesh/src/improve.ts
import { mkdirSync as mkdirSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join3 } from "node:path";
var IMPROVEMENT_REPORT_SCHEMA = "kxm.improvement-report.v1";
function buildImprovementReport(events, targets) {
  const selected = events.filter((event) => targets.includes(event.target));
  const buckets = /* @__PURE__ */ new Map();
  for (const event of selected) {
    const area = event.envelope.worker.kind === "gate" ? "gates" : "harness";
    const key = `${event.target}:${area}:${event.envelope.command}:${event.envelope.outcome}`;
    const existing = buckets.get(key);
    const evidence = `${event.envelope.command}:${event.envelope.outcome}:${event.envelope.summary}`.slice(0, 200);
    if (existing) {
      existing.count += 1;
      if (existing.evidence.length < 8) existing.evidence.push(evidence);
      continue;
    }
    buckets.set(key, {
      target: event.target,
      area,
      count: 1,
      summary: `${event.envelope.worker.kind} ${event.envelope.command} ${event.envelope.outcome} (${event.target})`,
      evidence: [evidence]
    });
  }
  const proposals = [...buckets.values()].sort((left, right) => right.count - left.count || left.summary.localeCompare(right.summary));
  return {
    schema: IMPROVEMENT_REPORT_SCHEMA,
    createdAt: nowIso(),
    reviewDecision: "proposed",
    events: selected.length,
    targets,
    proposals
  };
}
function writeImprovementReport(improvementsDir, report, dryRun = false) {
  const stamp = report.createdAt.replace(/[:.]/g, "-");
  const path5 = join3(improvementsDir, `${stamp}.json`);
  if (!dryRun) {
    mkdirSync4(improvementsDir, { recursive: true });
    writeFileSync3(path5, `${JSON.stringify(report, null, 2)}
`, { encoding: "utf8" });
  }
  return path5;
}

// plugins/kxm-mesh/src/tui.ts
import { existsSync as existsSync2, readdirSync, readFileSync as readFileSync3 } from "node:fs";
import { join as join8 } from "node:path";
import { DatabaseSync } from "node:sqlite";

// node_modules/marked/lib/marked.esm.js
function M() {
  return { async: false, breaks: false, extensions: null, gfm: true, hooks: null, pedantic: false, renderer: null, silent: false, tokenizer: null, walkTokens: null };
}
var T = M();
function N(l3) {
  T = l3;
}
var _ = { exec: () => null };
function E(l3) {
  let e = [];
  return (t) => {
    let n = Math.max(0, Math.min(3, t - 1)), s = e[n];
    return s || (s = l3(n), e[n] = s), s;
  };
}
function d(l3, e = "") {
  let t = typeof l3 == "string" ? l3 : l3.source, n = { replace: (s, r) => {
    let i = typeof r == "string" ? r : r.source;
    return i = i.replace(m.caret, "$1"), t = t.replace(s, i), n;
  }, getRegex: () => new RegExp(t, e) };
  return n;
}
var Te = ((l3 = "") => {
  try {
    return !!new RegExp("(?<=1)(?<!1)" + l3);
  } catch {
    return false;
  }
})();
var m = { codeRemoveIndent: /^(?: {1,4}| {0,3}\t)/gm, outputLinkReplace: /\\([\[\]])/g, indentCodeCompensation: /^(\s+)(?:```)/, beginningSpace: /^\s+/, endingHash: /#$/, startingSpaceChar: /^ /, endingSpaceChar: / $/, nonSpaceChar: /[^ ]/, newLineCharGlobal: /\n/g, tabCharGlobal: /\t/g, multipleSpaceGlobal: /\s+/g, blankLine: /^[ \t]*$/, doubleBlankLine: /\n[ \t]*\n[ \t]*$/, blockquoteStart: /^ {0,3}>/, blockquoteSetextReplace: /\n {0,3}((?:=+|-+) *)(?=\n|$)/g, blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm, listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g, listIsTask: /^\[[ xX]\] +\S/, listReplaceTask: /^\[[ xX]\] +/, listTaskCheckbox: /\[[ xX]\]/, anyLine: /\n.*\n/, hrefBrackets: /^<(.*)>$/, tableDelimiter: /[:|]/, tableAlignChars: /^\||\| *$/g, tableRowBlankLine: /\n[ \t]*$/, tableAlignRight: /^ *-+: *$/, tableAlignCenter: /^ *:-+: *$/, tableAlignLeft: /^ *:-+ *$/, startATag: /^<a /i, endATag: /^<\/a>/i, startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i, endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i, startAngleBracket: /^</, endAngleBracket: />$/, pedanticHrefTitle: /^([^'"]*[^\s])\s+(['"])(.*)\2/, unicodeAlphaNumeric: /[\p{L}\p{N}]/u, escapeTest: /[&<>"']/, escapeReplace: /[&<>"']/g, escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/, escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, caret: /(^|[^\[])\^/g, percentDecode: /%25/g, findPipe: /\|/g, splitPipe: / \|/, slashPipe: /\\\|/g, carriageReturn: /\r\n|\r/g, spaceLine: /^ +$/gm, notSpaceStart: /^\S*/, endingNewline: /\n$/, listItemRegex: (l3) => new RegExp(`^( {0,3}${l3})((?:[	 ][^\\n]*)?(?:\\n|$))`), nextBulletRegex: E((l3) => new RegExp(`^ {0,${l3}}(?:[*+-]|\\d{1,9}[.)])((?:[ 	][^\\n]*)?(?:\\n|$))`)), hrRegex: E((l3) => new RegExp(`^ {0,${l3}}((?:- *){3,}|(?:_ *){3,}|(?:\\* *){3,})(?:\\n+|$)`)), fencesBeginRegex: E((l3) => new RegExp(`^ {0,${l3}}(?:\`\`\`|~~~)`)), headingBeginRegex: E((l3) => new RegExp(`^ {0,${l3}}#`)), htmlBeginRegex: E((l3) => new RegExp(`^ {0,${l3}}<(?:[a-z].*>|!--)`, "i")), blockquoteBeginRegex: E((l3) => new RegExp(`^ {0,${l3}}>`)) };
var Oe = /^(?:[ \t]*(?:\n|$))+/;
var we = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
var ye = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/;
var B = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
var Pe = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
var j = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
var oe = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |blockCode|fences|blockquote|heading|html|table))+?)\n {0,3}(=+|-+) *(?:\n+|$)/;
var ae = d(oe).replace(/bull/g, j).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/\|table/g, "").getRegex();
var Se = d(oe).replace(/bull/g, j).replace(/blockCode/g, /(?: {4}| {0,3}\t)/).replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/).replace(/heading/g, / {0,3}#{1,6}/).replace(/html/g, / {0,3}<[^\n>]+>\n/).replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex();
var F = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table| +\n)[^\n]+)*)/;
var $e = /^[^\n]+/;
var U = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\])+/;
var Le = d(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/).replace("label", U).replace("title", /(?:"(?:\\"?|[^"\\])*"|'[^'\n]*(?:\n[^'\n]+)*\n?'|\([^()]*\))/).getRegex();
var _e = d(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, j).getRegex();
var H = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
var K = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
var ze = d("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n+|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>\\n*|$)|<![A-Z][\\s\\S]*?(?:>\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>\\n*|$)|</?(tag)(?: +|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|<(?!script|pre|style|textarea)([a-z][\\w-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$)|</(?!script|pre|style|textarea)[a-z][\\w-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ 	]*)+\\n|$))", "i").replace("comment", K).replace("tag", H).replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex();
var le = d(F).replace("hr", B).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("|table", "").replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", H).getRegex();
var Me = d(/^( {0,3}> ?(paragraph|[^\n]*)(?:\n|$))+/).replace("paragraph", le).getRegex();
var W = { blockquote: Me, code: we, def: Le, fences: ye, heading: Pe, hr: B, html: ze, lheading: ae, list: _e, newline: Oe, paragraph: le, table: _, text: $e };
var se = d("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)").replace("hr", B).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("blockquote", " {0,3}>").replace("code", "(?: {4}| {0,3}	)[^\\n]").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", H).getRegex();
var Ee = { ...W, lheading: Se, table: se, paragraph: d(F).replace("hr", B).replace("heading", " {0,3}#{1,6}(?:\\s|$)").replace("|lheading", "").replace("table", se).replace("blockquote", " {0,3}>").replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*\\n)|~{3,})[^\\n]*\\n").replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]").replace("html", "</?(?:tag)(?: +|\\n|/?>)|<(?:script|pre|style|textarea|!--)").replace("tag", H).getRegex() };
var Ie = { ...W, html: d(`^ *(?:comment *(?:\\n|\\s*$)|<(tag)[\\s\\S]+?</\\1> *(?:\\n{2,}|\\s*$)|<tag(?:"[^"]*"|'[^']*'|\\s[^'"/>\\s]*)*?/?> *(?:\\n{2,}|\\s*$))`).replace("comment", K).replace(/tag/g, "(?!(?:a|em|strong|small|s|cite|q|dfn|abbr|data|time|code|var|samp|kbd|sub|sup|i|b|u|mark|ruby|rt|rp|bdi|bdo|span|br|wbr|ins|del|img)\\b)\\w+(?!:|[^\\w\\s@]*@)\\b").getRegex(), def: /^ *\[([^\]]+)\]: *<?([^\s>]+)>?(?: +(["(][^\n]+[")]))? *(?:\n+|$)/, heading: /^(#{1,6})(.*)(?:\n+|$)/, fences: _, lheading: /^(.+?)\n {0,3}(=+|-+) *(?:\n+|$)/, paragraph: d(F).replace("hr", B).replace("heading", ` *#{1,6} *[^
]`).replace("lheading", ae).replace("|table", "").replace("blockquote", " {0,3}>").replace("|fences", "").replace("|list", "").replace("|html", "").replace("|tag", "").getRegex() };
var Ae = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
var Ce = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
var ue = /^( {2,}|\\)\n(?!\s*$)/;
var Be = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
var I = /[\p{P}\p{S}]/u;
var Z = /[\s\p{P}\p{S}]/u;
var X = /[^\s\p{P}\p{S}]/u;
var De = d(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, Z).getRegex();
var pe = /(?!~)[\p{P}\p{S}]/u;
var qe = /(?!~)[\s\p{P}\p{S}]/u;
var ve = /(?:[^\s\p{P}\p{S}]|~)/u;
var He = d(/link|precode-code|html/, "g").replace("link", /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/).replace("precode-", Te ? "(?<!`)()" : "(^^|[^`])").replace("code", /(?<b>`+)[^`]+\k<b>(?!`)/).replace("html", /<(?! )[^<>]*?>/).getRegex();
var ce = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
var Ze = d(ce, "u").replace(/punct/g, I).getRegex();
var Ge = d(ce, "u").replace(/punct/g, pe).getRegex();
var he = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
var Ne = d(he, "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, Z).replace(/punct/g, I).getRegex();
var Qe = d(he, "gu").replace(/notPunctSpace/g, ve).replace(/punctSpace/g, qe).replace(/punct/g, pe).getRegex();
var je = d("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, Z).replace(/punct/g, I).getRegex();
var Fe = d(/^~~?(?:((?!~)punct)|[^\s~])/, "u").replace(/punct/g, I).getRegex();
var Ue = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
var Ke = d(Ue, "gu").replace(/notPunctSpace/g, X).replace(/punctSpace/g, Z).replace(/punct/g, I).getRegex();
var We = d(/\\(punct)/, "gu").replace(/punct/g, I).getRegex();
var Xe = d(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/).replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/).replace("email", /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex();
var Je = d(K).replace("(?:-->|$)", "-->").getRegex();
var Ve = d("^comment|^</[a-zA-Z][\\w:-]*\\s*>|^<[a-zA-Z][\\w-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>").replace("comment", Je).replace("attribute", /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex();
var v = /(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/;
var Ye = d(/^!?\[(label)\]\(\s*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?\s*\)/).replace("label", v).replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]*/).replace("title", /"(?:\\"?|[^"\\])*"|'(?:\\'?|[^'\\])*'|\((?:\\\)?|[^)\\])*\)/).getRegex();
var ke = d(/^!?\[(label)\]\[(ref)\]/).replace("label", v).replace("ref", U).getRegex();
var de = d(/^!?\[(ref)\](?:\[\])?/).replace("ref", U).getRegex();
var et = d("reflink|nolink(?!\\()", "g").replace("reflink", ke).replace("nolink", de).getRegex();
var ie = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
var J = { _backpedal: _, anyPunctuation: We, autolink: Xe, blockSkip: He, br: ue, code: Ce, del: _, delLDelim: _, delRDelim: _, emStrongLDelim: Ze, emStrongRDelimAst: Ne, emStrongRDelimUnd: je, escape: Ae, link: Ye, nolink: de, punctuation: De, reflink: ke, reflinkSearch: et, tag: Ve, text: Be, url: _ };
var tt = { ...J, link: d(/^!?\[(label)\]\((.*?)\)/).replace("label", v).getRegex(), reflink: d(/^!?\[(label)\]\s*\[([^\]]*)\]/).replace("label", v).getRegex() };
var Q = { ...J, emStrongRDelimAst: Qe, emStrongLDelim: Ge, delLDelim: Fe, delRDelim: Ke, url: d(/^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/).replace("protocol", ie).replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/).getRegex(), _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/, del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/, text: d(/^([`~]+|[^`~])(?:(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)))/).replace("protocol", ie).getRegex() };
var nt = { ...Q, br: d(ue).replace("{2,}", "*").getRegex(), text: d(Q.text).replace("\\b_", "\\b_| {2,}\\n").replace(/\{2,\}/g, "*").getRegex() };
var D = { normal: W, gfm: Ee, pedantic: Ie };
var A = { normal: J, gfm: Q, breaks: nt, pedantic: tt };
var rt = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
var ge = (l3) => rt[l3];
function O(l3, e) {
  if (e) {
    if (m.escapeTest.test(l3)) return l3.replace(m.escapeReplace, ge);
  } else if (m.escapeTestNoEncode.test(l3)) return l3.replace(m.escapeReplaceNoEncode, ge);
  return l3;
}
function V(l3) {
  try {
    l3 = encodeURI(l3).replace(m.percentDecode, "%");
  } catch {
    return null;
  }
  return l3;
}
function Y(l3, e) {
  let t = l3.replace(m.findPipe, (r, i, o) => {
    let u = false, a = i;
    for (; --a >= 0 && o[a] === "\\"; ) u = !u;
    return u ? "|" : " |";
  }), n = t.split(m.splitPipe), s = 0;
  if (n[0].trim() || n.shift(), n.length > 0 && !n.at(-1)?.trim() && n.pop(), e) if (n.length > e) n.splice(e);
  else for (; n.length < e; ) n.push("");
  for (; s < n.length; s++) n[s] = n[s].trim().replace(m.slashPipe, "|");
  return n;
}
function $(l3, e, t) {
  let n = l3.length;
  if (n === 0) return "";
  let s = 0;
  for (; s < n; ) {
    let r = l3.charAt(n - s - 1);
    if (r === e && !t) s++;
    else if (r !== e && t) s++;
    else break;
  }
  return l3.slice(0, n - s);
}
function ee(l3) {
  let e = l3.split(`
`), t = e.length - 1;
  for (; t >= 0 && m.blankLine.test(e[t]); ) t--;
  return e.length - t <= 2 ? l3 : e.slice(0, t + 1).join(`
`);
}
function fe(l3, e) {
  if (l3.indexOf(e[1]) === -1) return -1;
  let t = 0;
  for (let n = 0; n < l3.length; n++) if (l3[n] === "\\") n++;
  else if (l3[n] === e[0]) t++;
  else if (l3[n] === e[1] && (t--, t < 0)) return n;
  return t > 0 ? -2 : -1;
}
function me(l3, e = 0) {
  let t = e, n = "";
  for (let s of l3) if (s === "	") {
    let r = 4 - t % 4;
    n += " ".repeat(r), t += r;
  } else n += s, t++;
  return n;
}
function xe(l3, e, t, n, s) {
  let r = e.href, i = e.title || null, o = l3[1].replace(s.other.outputLinkReplace, "$1");
  n.state.inLink = true;
  let u = { type: l3[0].charAt(0) === "!" ? "image" : "link", raw: t, href: r, title: i, text: o, tokens: n.inlineTokens(o) };
  return n.state.inLink = false, u;
}
function st(l3, e, t) {
  let n = l3.match(t.other.indentCodeCompensation);
  if (n === null) return e;
  let s = n[1];
  return e.split(`
`).map((r) => {
    let i = r.match(t.other.beginningSpace);
    if (i === null) return r;
    let [o] = i;
    return o.length >= s.length ? r.slice(s.length) : r;
  }).join(`
`);
}
var w = class {
  options;
  rules;
  lexer;
  constructor(e) {
    this.options = e || T;
  }
  space(e) {
    let t = this.rules.block.newline.exec(e);
    if (t && t[0].length > 0) return { type: "space", raw: t[0] };
  }
  code(e) {
    let t = this.rules.block.code.exec(e);
    if (t) {
      let n = this.options.pedantic ? t[0] : ee(t[0]), s = n.replace(this.rules.other.codeRemoveIndent, "");
      return { type: "code", raw: n, codeBlockStyle: "indented", text: s };
    }
  }
  fences(e) {
    let t = this.rules.block.fences.exec(e);
    if (t) {
      let n = t[0], s = st(n, t[3] || "", this.rules);
      return { type: "code", raw: n, lang: t[2] ? t[2].trim().replace(this.rules.inline.anyPunctuation, "$1") : t[2], text: s };
    }
  }
  heading(e) {
    let t = this.rules.block.heading.exec(e);
    if (t) {
      let n = t[2].trim();
      if (this.rules.other.endingHash.test(n)) {
        let s = $(n, "#");
        (this.options.pedantic || !s || this.rules.other.endingSpaceChar.test(s)) && (n = s.trim());
      }
      return { type: "heading", raw: $(t[0], `
`), depth: t[1].length, text: n, tokens: this.lexer.inline(n) };
    }
  }
  hr(e) {
    let t = this.rules.block.hr.exec(e);
    if (t) return { type: "hr", raw: $(t[0], `
`) };
  }
  blockquote(e) {
    let t = this.rules.block.blockquote.exec(e);
    if (t) {
      let n = $(t[0], `
`).split(`
`), s = "", r = "", i = [];
      for (; n.length > 0; ) {
        let o = false, u = [], a;
        for (a = 0; a < n.length; a++) if (this.rules.other.blockquoteStart.test(n[a])) u.push(n[a]), o = true;
        else if (!o) u.push(n[a]);
        else break;
        n = n.slice(a);
        let c = u.join(`
`), p = c.replace(this.rules.other.blockquoteSetextReplace, `
    $1`).replace(this.rules.other.blockquoteSetextReplace2, "");
        s = s ? `${s}
${c}` : c, r = r ? `${r}
${p}` : p;
        let k = this.lexer.state.top;
        if (this.lexer.state.top = true, this.lexer.blockTokens(p, i, true), this.lexer.state.top = k, n.length === 0) break;
        let h = i.at(-1);
        if (h?.type === "code") break;
        if (h?.type === "blockquote") {
          let R = h, f = R.raw + `
` + n.join(`
`), S = this.blockquote(f);
          i[i.length - 1] = S, s = s.substring(0, s.length - R.raw.length) + S.raw, r = r.substring(0, r.length - R.text.length) + S.text;
          break;
        } else if (h?.type === "list") {
          let R = h, f = R.raw + `
` + n.join(`
`), S = this.list(f);
          i[i.length - 1] = S, s = s.substring(0, s.length - h.raw.length) + S.raw, r = r.substring(0, r.length - R.raw.length) + S.raw, n = f.substring(i.at(-1).raw.length).split(`
`);
          continue;
        }
      }
      return { type: "blockquote", raw: s, tokens: i, text: r };
    }
  }
  list(e) {
    let t = this.rules.block.list.exec(e);
    if (t) {
      let n = t[1].trim(), s = n.length > 1, r = { type: "list", raw: "", ordered: s, start: s ? +n.slice(0, -1) : "", loose: false, items: [] };
      n = s ? `\\d{1,9}\\${n.slice(-1)}` : `\\${n}`, this.options.pedantic && (n = s ? n : "[*+-]");
      let i = this.rules.other.listItemRegex(n), o = false;
      for (; e; ) {
        let a = false, c = "", p = "";
        if (!(t = i.exec(e)) || this.rules.block.hr.test(e)) break;
        c = t[0], e = e.substring(c.length);
        let k = me(t[2].split(`
`, 1)[0], t[1].length), h = e.split(`
`, 1)[0], R = !k.trim(), f = 0;
        if (this.options.pedantic ? (f = 2, p = k.trimStart()) : R ? f = t[1].length + 1 : (f = k.search(this.rules.other.nonSpaceChar), f = f > 4 ? 1 : f, p = k.slice(f), f += t[1].length), R && this.rules.other.blankLine.test(h) && (c += h + `
`, e = e.substring(h.length + 1), a = true), !a) {
          let S = this.rules.other.nextBulletRegex(f), te = this.rules.other.hrRegex(f), ne = this.rules.other.fencesBeginRegex(f), re = this.rules.other.headingBeginRegex(f), be = this.rules.other.htmlBeginRegex(f), Re = this.rules.other.blockquoteBeginRegex(f);
          for (; e; ) {
            let G = e.split(`
`, 1)[0], C;
            if (h = G, this.options.pedantic ? (h = h.replace(this.rules.other.listReplaceNesting, "  "), C = h) : C = h.replace(this.rules.other.tabCharGlobal, "    "), ne.test(h) || re.test(h) || be.test(h) || Re.test(h) || S.test(h) || te.test(h)) break;
            if (C.search(this.rules.other.nonSpaceChar) >= f || !h.trim()) p += `
` + C.slice(f);
            else {
              if (R || k.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4 || ne.test(k) || re.test(k) || te.test(k)) break;
              p += `
` + h;
            }
            R = !h.trim(), c += G + `
`, e = e.substring(G.length + 1), k = C.slice(f);
          }
        }
        r.loose || (o ? r.loose = true : this.rules.other.doubleBlankLine.test(c) && (o = true)), r.items.push({ type: "list_item", raw: c, task: !!this.options.gfm && this.rules.other.listIsTask.test(p), loose: false, text: p, tokens: [] }), r.raw += c;
      }
      let u = r.items.at(-1);
      if (u) u.raw = u.raw.trimEnd(), u.text = u.text.trimEnd();
      else return;
      r.raw = r.raw.trimEnd();
      for (let a of r.items) {
        this.lexer.state.top = false, a.tokens = this.lexer.blockTokens(a.text, []);
        let c = a.tokens[0];
        if (a.task && (c?.type === "text" || c?.type === "paragraph")) {
          a.text = a.text.replace(this.rules.other.listReplaceTask, ""), c.raw = c.raw.replace(this.rules.other.listReplaceTask, ""), c.text = c.text.replace(this.rules.other.listReplaceTask, "");
          for (let k = this.lexer.inlineQueue.length - 1; k >= 0; k--) if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[k].src)) {
            this.lexer.inlineQueue[k].src = this.lexer.inlineQueue[k].src.replace(this.rules.other.listReplaceTask, "");
            break;
          }
          let p = this.rules.other.listTaskCheckbox.exec(a.raw);
          if (p) {
            let k = { type: "checkbox", raw: p[0] + " ", checked: p[0] !== "[ ]" };
            a.checked = k.checked, r.loose ? a.tokens[0] && ["paragraph", "text"].includes(a.tokens[0].type) && "tokens" in a.tokens[0] && a.tokens[0].tokens ? (a.tokens[0].raw = k.raw + a.tokens[0].raw, a.tokens[0].text = k.raw + a.tokens[0].text, a.tokens[0].tokens.unshift(k)) : a.tokens.unshift({ type: "paragraph", raw: k.raw, text: k.raw, tokens: [k] }) : a.tokens.unshift(k);
          }
        } else a.task && (a.task = false);
        if (!r.loose) {
          let p = a.tokens.filter((h) => h.type === "space"), k = p.length > 0 && p.some((h) => this.rules.other.anyLine.test(h.raw));
          r.loose = k;
        }
      }
      if (r.loose) for (let a of r.items) {
        a.loose = true;
        for (let c of a.tokens) c.type === "text" && (c.type = "paragraph");
      }
      return r;
    }
  }
  html(e) {
    let t = this.rules.block.html.exec(e);
    if (t) {
      let n = ee(t[0]);
      return { type: "html", block: true, raw: n, pre: t[1] === "pre" || t[1] === "script" || t[1] === "style", text: n };
    }
  }
  def(e) {
    let t = this.rules.block.def.exec(e);
    if (t) {
      let n = t[1].toLowerCase().replace(this.rules.other.multipleSpaceGlobal, " "), s = t[2] ? t[2].replace(this.rules.other.hrefBrackets, "$1").replace(this.rules.inline.anyPunctuation, "$1") : "", r = t[3] ? t[3].substring(1, t[3].length - 1).replace(this.rules.inline.anyPunctuation, "$1") : t[3];
      return { type: "def", tag: n, raw: $(t[0], `
`), href: s, title: r };
    }
  }
  table(e) {
    let t = this.rules.block.table.exec(e);
    if (!t || !this.rules.other.tableDelimiter.test(t[2])) return;
    let n = Y(t[1]), s = t[2].replace(this.rules.other.tableAlignChars, "").split("|"), r = t[3]?.trim() ? t[3].replace(this.rules.other.tableRowBlankLine, "").split(`
`) : [], i = { type: "table", raw: $(t[0], `
`), header: [], align: [], rows: [] };
    if (n.length === s.length) {
      for (let o of s) this.rules.other.tableAlignRight.test(o) ? i.align.push("right") : this.rules.other.tableAlignCenter.test(o) ? i.align.push("center") : this.rules.other.tableAlignLeft.test(o) ? i.align.push("left") : i.align.push(null);
      for (let o = 0; o < n.length; o++) i.header.push({ text: n[o], tokens: this.lexer.inline(n[o]), header: true, align: i.align[o] });
      for (let o of r) i.rows.push(Y(o, i.header.length).map((u, a) => ({ text: u, tokens: this.lexer.inline(u), header: false, align: i.align[a] })));
      return i;
    }
  }
  lheading(e) {
    let t = this.rules.block.lheading.exec(e);
    if (t) {
      let n = t[1].trim();
      return { type: "heading", raw: $(t[0], `
`), depth: t[2].charAt(0) === "=" ? 1 : 2, text: n, tokens: this.lexer.inline(n) };
    }
  }
  paragraph(e) {
    let t = this.rules.block.paragraph.exec(e);
    if (t) {
      let n = t[1].charAt(t[1].length - 1) === `
` ? t[1].slice(0, -1) : t[1];
      return { type: "paragraph", raw: t[0], text: n, tokens: this.lexer.inline(n) };
    }
  }
  text(e) {
    let t = this.rules.block.text.exec(e);
    if (t) return { type: "text", raw: t[0], text: t[0], tokens: this.lexer.inline(t[0]) };
  }
  escape(e) {
    let t = this.rules.inline.escape.exec(e);
    if (t) return { type: "escape", raw: t[0], text: t[1] };
  }
  tag(e) {
    let t = this.rules.inline.tag.exec(e);
    if (t) return !this.lexer.state.inLink && this.rules.other.startATag.test(t[0]) ? this.lexer.state.inLink = true : this.lexer.state.inLink && this.rules.other.endATag.test(t[0]) && (this.lexer.state.inLink = false), !this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(t[0]) ? this.lexer.state.inRawBlock = true : this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(t[0]) && (this.lexer.state.inRawBlock = false), { type: "html", raw: t[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: false, text: t[0] };
  }
  link(e) {
    let t = this.rules.inline.link.exec(e);
    if (t) {
      let n = t[2].trim();
      if (!this.options.pedantic && this.rules.other.startAngleBracket.test(n)) {
        if (!this.rules.other.endAngleBracket.test(n)) return;
        let i = $(n.slice(0, -1), "\\");
        if ((n.length - i.length) % 2 === 0) return;
      } else {
        let i = fe(t[2], "()");
        if (i === -2) return;
        if (i > -1) {
          let u = (t[0].indexOf("!") === 0 ? 5 : 4) + t[1].length + i;
          t[2] = t[2].substring(0, i), t[0] = t[0].substring(0, u).trim(), t[3] = "";
        }
      }
      let s = t[2], r = "";
      if (this.options.pedantic) {
        let i = this.rules.other.pedanticHrefTitle.exec(s);
        i && (s = i[1], r = i[3]);
      } else r = t[3] ? t[3].slice(1, -1) : "";
      return s = s.trim(), this.rules.other.startAngleBracket.test(s) && (this.options.pedantic && !this.rules.other.endAngleBracket.test(n) ? s = s.slice(1) : s = s.slice(1, -1)), xe(t, { href: s && s.replace(this.rules.inline.anyPunctuation, "$1"), title: r && r.replace(this.rules.inline.anyPunctuation, "$1") }, t[0], this.lexer, this.rules);
    }
  }
  reflink(e, t) {
    let n;
    if ((n = this.rules.inline.reflink.exec(e)) || (n = this.rules.inline.nolink.exec(e))) {
      let s = (n[2] || n[1]).replace(this.rules.other.multipleSpaceGlobal, " "), r = t[s.toLowerCase()];
      if (!r) {
        let i = n[0].charAt(0);
        return { type: "text", raw: i, text: i };
      }
      return xe(n, r, n[0], this.lexer, this.rules);
    }
  }
  emStrong(e, t, n = "") {
    let s = this.rules.inline.emStrongLDelim.exec(e);
    if (!s || !s[1] && !s[2] && !s[3] && !s[4] || s[4] && n.match(this.rules.other.unicodeAlphaNumeric)) return;
    if (!(s[1] || s[3] || "") || !n || this.rules.inline.punctuation.exec(n)) {
      let i = [...s[0]].length - 1, o, u, a = i, c = 0, p = s[0][0] === "*" ? this.rules.inline.emStrongRDelimAst : this.rules.inline.emStrongRDelimUnd;
      for (p.lastIndex = 0, t = t.slice(-1 * e.length + i); (s = p.exec(t)) !== null; ) {
        if (o = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !o) continue;
        if (u = [...o].length, s[3] || s[4]) {
          a += u;
          continue;
        } else if ((s[5] || s[6]) && i % 3 && !((i + u) % 3)) {
          c += u;
          continue;
        }
        if (a -= u, a > 0) continue;
        u = Math.min(u, u + a + c);
        let k = [...s[0]][0].length, h = e.slice(0, i + s.index + k + u);
        if (Math.min(i, u) % 2) {
          let f = h.slice(1, -1);
          return { type: "em", raw: h, text: f, tokens: this.lexer.inlineTokens(f) };
        }
        let R = h.slice(2, -2);
        return { type: "strong", raw: h, text: R, tokens: this.lexer.inlineTokens(R) };
      }
    }
  }
  codespan(e) {
    let t = this.rules.inline.code.exec(e);
    if (t) {
      let n = t[2].replace(this.rules.other.newLineCharGlobal, " "), s = this.rules.other.nonSpaceChar.test(n), r = this.rules.other.startingSpaceChar.test(n) && this.rules.other.endingSpaceChar.test(n);
      return s && r && (n = n.substring(1, n.length - 1)), { type: "codespan", raw: t[0], text: n };
    }
  }
  br(e) {
    let t = this.rules.inline.br.exec(e);
    if (t) return { type: "br", raw: t[0] };
  }
  del(e, t, n = "") {
    let s = this.rules.inline.delLDelim.exec(e);
    if (!s) return;
    if (!(s[1] || "") || !n || this.rules.inline.punctuation.exec(n)) {
      let i = [...s[0]].length - 1, o, u, a = i, c = this.rules.inline.delRDelim;
      for (c.lastIndex = 0, t = t.slice(-1 * e.length + i); (s = c.exec(t)) !== null; ) {
        if (o = s[1] || s[2] || s[3] || s[4] || s[5] || s[6], !o || (u = [...o].length, u !== i)) continue;
        if (s[3] || s[4]) {
          a += u;
          continue;
        }
        if (a -= u, a > 0) continue;
        u = Math.min(u, u + a);
        let p = [...s[0]][0].length, k = e.slice(0, i + s.index + p + u), h = k.slice(i, -i);
        return { type: "del", raw: k, text: h, tokens: this.lexer.inlineTokens(h) };
      }
    }
  }
  autolink(e) {
    let t = this.rules.inline.autolink.exec(e);
    if (t) {
      let n, s;
      return t[2] === "@" ? (n = t[1], s = "mailto:" + n) : (n = t[1], s = n), { type: "link", raw: t[0], text: n, href: s, tokens: [{ type: "text", raw: n, text: n }] };
    }
  }
  url(e) {
    let t;
    if (t = this.rules.inline.url.exec(e)) {
      let n, s;
      if (t[2] === "@") n = t[0], s = "mailto:" + n;
      else {
        let r;
        do
          r = t[0], t[0] = this.rules.inline._backpedal.exec(t[0])?.[0] ?? "";
        while (r !== t[0]);
        n = t[0], t[1] === "www." ? s = "http://" + t[0] : s = t[0];
      }
      return { type: "link", raw: t[0], text: n, href: s, tokens: [{ type: "text", raw: n, text: n }] };
    }
  }
  inlineText(e) {
    let t = this.rules.inline.text.exec(e);
    if (t) {
      let n = this.lexer.state.inRawBlock;
      return { type: "text", raw: t[0], text: t[0], escaped: n };
    }
  }
};
var x = class l {
  tokens;
  options;
  state;
  inlineQueue;
  tokenizer;
  constructor(e) {
    this.tokens = [], this.tokens.links = /* @__PURE__ */ Object.create(null), this.options = e || T, this.options.tokenizer = this.options.tokenizer || new w(), this.tokenizer = this.options.tokenizer, this.tokenizer.options = this.options, this.tokenizer.lexer = this, this.inlineQueue = [], this.state = { inLink: false, inRawBlock: false, top: true };
    let t = { other: m, block: D.normal, inline: A.normal };
    this.options.pedantic ? (t.block = D.pedantic, t.inline = A.pedantic) : this.options.gfm && (t.block = D.gfm, this.options.breaks ? t.inline = A.breaks : t.inline = A.gfm), this.tokenizer.rules = t;
  }
  static get rules() {
    return { block: D, inline: A };
  }
  static lex(e, t) {
    return new l(t).lex(e);
  }
  static lexInline(e, t) {
    return new l(t).inlineTokens(e);
  }
  lex(e) {
    e = e.replace(m.carriageReturn, `
`), this.blockTokens(e, this.tokens);
    for (let t = 0; t < this.inlineQueue.length; t++) {
      let n = this.inlineQueue[t];
      this.inlineTokens(n.src, n.tokens);
    }
    return this.inlineQueue = [], this.tokens;
  }
  blockTokens(e, t = [], n = false) {
    this.tokenizer.lexer = this, this.options.pedantic && (e = e.replace(m.tabCharGlobal, "    ").replace(m.spaceLine, ""));
    let s = 1 / 0;
    for (; e; ) {
      if (e.length < s) s = e.length;
      else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      let r;
      if (this.options.extensions?.block?.some((o) => (r = o.call({ lexer: this }, e, t)) ? (e = e.substring(r.raw.length), t.push(r), true) : false)) continue;
      if (r = this.tokenizer.space(e)) {
        e = e.substring(r.raw.length);
        let o = t.at(-1);
        r.raw.length === 1 && o !== void 0 ? o.raw += `
` : t.push(r);
        continue;
      }
      if (r = this.tokenizer.code(e)) {
        e = e.substring(r.raw.length);
        let o = t.at(-1);
        o?.type === "paragraph" || o?.type === "text" ? (o.raw += (o.raw.endsWith(`
`) ? "" : `
`) + r.raw, o.text += `
` + r.text, this.inlineQueue.at(-1).src = o.text) : t.push(r);
        continue;
      }
      if (r = this.tokenizer.fences(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.heading(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.hr(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.blockquote(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.list(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.html(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.def(e)) {
        e = e.substring(r.raw.length);
        let o = t.at(-1);
        o?.type === "paragraph" || o?.type === "text" ? (o.raw += (o.raw.endsWith(`
`) ? "" : `
`) + r.raw, o.text += `
` + r.raw, this.inlineQueue.at(-1).src = o.text) : this.tokens.links[r.tag] || (this.tokens.links[r.tag] = { href: r.href, title: r.title }, t.push(r));
        continue;
      }
      if (r = this.tokenizer.table(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      if (r = this.tokenizer.lheading(e)) {
        e = e.substring(r.raw.length), t.push(r);
        continue;
      }
      let i = e;
      if (this.options.extensions?.startBlock) {
        let o = 1 / 0, u = e.slice(1), a;
        this.options.extensions.startBlock.forEach((c) => {
          a = c.call({ lexer: this }, u), typeof a == "number" && a >= 0 && (o = Math.min(o, a));
        }), o < 1 / 0 && o >= 0 && (i = e.substring(0, o + 1));
      }
      if (this.state.top && (r = this.tokenizer.paragraph(i))) {
        let o = t.at(-1);
        n && o?.type === "paragraph" ? (o.raw += (o.raw.endsWith(`
`) ? "" : `
`) + r.raw, o.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = o.text) : t.push(r), n = i.length !== e.length, e = e.substring(r.raw.length);
        continue;
      }
      if (r = this.tokenizer.text(e)) {
        e = e.substring(r.raw.length);
        let o = t.at(-1);
        o?.type === "text" ? (o.raw += (o.raw.endsWith(`
`) ? "" : `
`) + r.raw, o.text += `
` + r.text, this.inlineQueue.pop(), this.inlineQueue.at(-1).src = o.text) : t.push(r);
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    return this.state.top = true, t;
  }
  inline(e, t = []) {
    return this.inlineQueue.push({ src: e, tokens: t }), t;
  }
  inlineTokens(e, t = []) {
    this.tokenizer.lexer = this;
    let n = e, s = null;
    if (this.tokens.links) {
      let a = Object.keys(this.tokens.links);
      if (a.length > 0) for (; (s = this.tokenizer.rules.inline.reflinkSearch.exec(n)) !== null; ) a.includes(s[0].slice(s[0].lastIndexOf("[") + 1, -1)) && (n = n.slice(0, s.index) + "[" + "a".repeat(s[0].length - 2) + "]" + n.slice(this.tokenizer.rules.inline.reflinkSearch.lastIndex));
    }
    for (; (s = this.tokenizer.rules.inline.anyPunctuation.exec(n)) !== null; ) n = n.slice(0, s.index) + "++" + n.slice(this.tokenizer.rules.inline.anyPunctuation.lastIndex);
    let r;
    for (; (s = this.tokenizer.rules.inline.blockSkip.exec(n)) !== null; ) r = s[2] ? s[2].length : 0, n = n.slice(0, s.index + r) + "[" + "a".repeat(s[0].length - r - 2) + "]" + n.slice(this.tokenizer.rules.inline.blockSkip.lastIndex);
    n = this.options.hooks?.emStrongMask?.call({ lexer: this }, n) ?? n;
    let i = false, o = "", u = 1 / 0;
    for (; e; ) {
      if (e.length < u) u = e.length;
      else {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
      i || (o = ""), i = false;
      let a;
      if (this.options.extensions?.inline?.some((p) => (a = p.call({ lexer: this }, e, t)) ? (e = e.substring(a.raw.length), t.push(a), true) : false)) continue;
      if (a = this.tokenizer.escape(e)) {
        e = e.substring(a.raw.length), t.push(a);
        continue;
      }
      if (a = this.tokenizer.tag(e)) {
        e = e.substring(a.raw.length), t.push(a);
        continue;
      }
      if (a = this.tokenizer.link(e)) {
        e = e.substring(a.raw.length), t.push(a);
        continue;
      }
      if (a = this.tokenizer.reflink(e, this.tokens.links)) {
        e = e.substring(a.raw.length);
        let p = t.at(-1);
        a.type === "text" && p?.type === "text" ? (p.raw += a.raw, p.text += a.text) : t.push(a);
        continue;
      }
      if (a = this.tokenizer.emStrong(e, n, o)) {
        e = e.substring(a.raw.length), t.push(a);
        continue;
      }
      if (a = this.tokenizer.codespan(e)) {
        e = e.substring(a.raw.length), t.push(a);
        continue;
      }
      if (a = this.tokenizer.br(e)) {
        e = e.substring(a.raw.length), t.push(a);
        continue;
      }
      if (a = this.tokenizer.del(e, n, o)) {
        e = e.substring(a.raw.length), t.push(a);
        continue;
      }
      if (a = this.tokenizer.autolink(e)) {
        e = e.substring(a.raw.length), t.push(a);
        continue;
      }
      if (!this.state.inLink && (a = this.tokenizer.url(e))) {
        e = e.substring(a.raw.length), t.push(a);
        continue;
      }
      let c = e;
      if (this.options.extensions?.startInline) {
        let p = 1 / 0, k = e.slice(1), h;
        this.options.extensions.startInline.forEach((R) => {
          h = R.call({ lexer: this }, k), typeof h == "number" && h >= 0 && (p = Math.min(p, h));
        }), p < 1 / 0 && p >= 0 && (c = e.substring(0, p + 1));
      }
      if (a = this.tokenizer.inlineText(c)) {
        e = e.substring(a.raw.length), a.raw.slice(-1) !== "_" && (o = a.raw.slice(-1)), i = true;
        let p = t.at(-1);
        p?.type === "text" ? (p.raw += a.raw, p.text += a.text) : t.push(a);
        continue;
      }
      if (e) {
        this.infiniteLoopError(e.charCodeAt(0));
        break;
      }
    }
    return t;
  }
  infiniteLoopError(e) {
    let t = "Infinite loop on byte: " + e;
    if (this.options.silent) console.error(t);
    else throw new Error(t);
  }
};
var y = class {
  options;
  parser;
  constructor(e) {
    this.options = e || T;
  }
  space(e) {
    return "";
  }
  code({ text: e, lang: t, escaped: n }) {
    let s = (t || "").match(m.notSpaceStart)?.[0], r = e.replace(m.endingNewline, "") + `
`;
    return s ? '<pre><code class="language-' + O(s) + '">' + (n ? r : O(r, true)) + `</code></pre>
` : "<pre><code>" + (n ? r : O(r, true)) + `</code></pre>
`;
  }
  blockquote({ tokens: e }) {
    return `<blockquote>
${this.parser.parse(e)}</blockquote>
`;
  }
  html({ text: e }) {
    return e;
  }
  def(e) {
    return "";
  }
  heading({ tokens: e, depth: t }) {
    return `<h${t}>${this.parser.parseInline(e)}</h${t}>
`;
  }
  hr(e) {
    return `<hr>
`;
  }
  list(e) {
    let t = e.ordered, n = e.start, s = "";
    for (let o = 0; o < e.items.length; o++) {
      let u = e.items[o];
      s += this.listitem(u);
    }
    let r = t ? "ol" : "ul", i = t && n !== 1 ? ' start="' + n + '"' : "";
    return "<" + r + i + `>
` + s + "</" + r + `>
`;
  }
  listitem(e) {
    return `<li>${this.parser.parse(e.tokens)}</li>
`;
  }
  checkbox({ checked: e }) {
    return "<input " + (e ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
  }
  paragraph({ tokens: e }) {
    return `<p>${this.parser.parseInline(e)}</p>
`;
  }
  table(e) {
    let t = "", n = "";
    for (let r = 0; r < e.header.length; r++) n += this.tablecell(e.header[r]);
    t += this.tablerow({ text: n });
    let s = "";
    for (let r = 0; r < e.rows.length; r++) {
      let i = e.rows[r];
      n = "";
      for (let o = 0; o < i.length; o++) n += this.tablecell(i[o]);
      s += this.tablerow({ text: n });
    }
    return s && (s = `<tbody>${s}</tbody>`), `<table>
<thead>
` + t + `</thead>
` + s + `</table>
`;
  }
  tablerow({ text: e }) {
    return `<tr>
${e}</tr>
`;
  }
  tablecell(e) {
    let t = this.parser.parseInline(e.tokens), n = e.header ? "th" : "td";
    return (e.align ? `<${n} align="${e.align}">` : `<${n}>`) + t + `</${n}>
`;
  }
  strong({ tokens: e }) {
    return `<strong>${this.parser.parseInline(e)}</strong>`;
  }
  em({ tokens: e }) {
    return `<em>${this.parser.parseInline(e)}</em>`;
  }
  codespan({ text: e }) {
    return `<code>${O(e, true)}</code>`;
  }
  br(e) {
    return "<br>";
  }
  del({ tokens: e }) {
    return `<del>${this.parser.parseInline(e)}</del>`;
  }
  link({ href: e, title: t, tokens: n }) {
    let s = this.parser.parseInline(n), r = V(e);
    if (r === null) return s;
    e = r;
    let i = '<a href="' + e + '"';
    return t && (i += ' title="' + O(t) + '"'), i += ">" + s + "</a>", i;
  }
  image({ href: e, title: t, text: n, tokens: s }) {
    s && (n = this.parser.parseInline(s, this.parser.textRenderer));
    let r = V(e);
    if (r === null) return O(n);
    e = r;
    let i = `<img src="${e}" alt="${O(n)}"`;
    return t && (i += ` title="${O(t)}"`), i += ">", i;
  }
  text(e) {
    return "tokens" in e && e.tokens ? this.parser.parseInline(e.tokens) : "escaped" in e && e.escaped ? e.text : O(e.text);
  }
};
var L = class {
  strong({ text: e }) {
    return e;
  }
  em({ text: e }) {
    return e;
  }
  codespan({ text: e }) {
    return e;
  }
  del({ text: e }) {
    return e;
  }
  html({ text: e }) {
    return e;
  }
  text({ text: e }) {
    return e;
  }
  link({ text: e }) {
    return "" + e;
  }
  image({ text: e }) {
    return "" + e;
  }
  br() {
    return "";
  }
  checkbox({ raw: e }) {
    return e;
  }
};
var b = class l2 {
  options;
  renderer;
  textRenderer;
  constructor(e) {
    this.options = e || T, this.options.renderer = this.options.renderer || new y(), this.renderer = this.options.renderer, this.renderer.options = this.options, this.renderer.parser = this, this.textRenderer = new L();
  }
  static parse(e, t) {
    return new l2(t).parse(e);
  }
  static parseInline(e, t) {
    return new l2(t).parseInline(e);
  }
  parse(e) {
    this.renderer.parser = this;
    let t = "";
    for (let n = 0; n < e.length; n++) {
      let s = e[n];
      if (this.options.extensions?.renderers?.[s.type]) {
        let i = s, o = this.options.extensions.renderers[i.type].call({ parser: this }, i);
        if (o !== false || !["space", "hr", "heading", "code", "table", "blockquote", "list", "html", "def", "paragraph", "text"].includes(i.type)) {
          t += o || "";
          continue;
        }
      }
      let r = s;
      switch (r.type) {
        case "space": {
          t += this.renderer.space(r);
          break;
        }
        case "hr": {
          t += this.renderer.hr(r);
          break;
        }
        case "heading": {
          t += this.renderer.heading(r);
          break;
        }
        case "code": {
          t += this.renderer.code(r);
          break;
        }
        case "table": {
          t += this.renderer.table(r);
          break;
        }
        case "blockquote": {
          t += this.renderer.blockquote(r);
          break;
        }
        case "list": {
          t += this.renderer.list(r);
          break;
        }
        case "checkbox": {
          t += this.renderer.checkbox(r);
          break;
        }
        case "html": {
          t += this.renderer.html(r);
          break;
        }
        case "def": {
          t += this.renderer.def(r);
          break;
        }
        case "paragraph": {
          t += this.renderer.paragraph(r);
          break;
        }
        case "text": {
          t += this.renderer.text(r);
          break;
        }
        default: {
          let i = 'Token with "' + r.type + '" type was not found.';
          if (this.options.silent) return console.error(i), "";
          throw new Error(i);
        }
      }
    }
    return t;
  }
  parseInline(e, t = this.renderer) {
    this.renderer.parser = this;
    let n = "";
    for (let s = 0; s < e.length; s++) {
      let r = e[s];
      if (this.options.extensions?.renderers?.[r.type]) {
        let o = this.options.extensions.renderers[r.type].call({ parser: this }, r);
        if (o !== false || !["escape", "html", "link", "image", "strong", "em", "codespan", "br", "del", "text"].includes(r.type)) {
          n += o || "";
          continue;
        }
      }
      let i = r;
      switch (i.type) {
        case "escape": {
          n += t.text(i);
          break;
        }
        case "html": {
          n += t.html(i);
          break;
        }
        case "link": {
          n += t.link(i);
          break;
        }
        case "image": {
          n += t.image(i);
          break;
        }
        case "checkbox": {
          n += t.checkbox(i);
          break;
        }
        case "strong": {
          n += t.strong(i);
          break;
        }
        case "em": {
          n += t.em(i);
          break;
        }
        case "codespan": {
          n += t.codespan(i);
          break;
        }
        case "br": {
          n += t.br(i);
          break;
        }
        case "del": {
          n += t.del(i);
          break;
        }
        case "text": {
          n += t.text(i);
          break;
        }
        default: {
          let o = 'Token with "' + i.type + '" type was not found.';
          if (this.options.silent) return console.error(o), "";
          throw new Error(o);
        }
      }
    }
    return n;
  }
};
var P = class {
  options;
  block;
  constructor(e) {
    this.options = e || T;
  }
  static passThroughHooks = /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens", "emStrongMask"]);
  static passThroughHooksRespectAsync = /* @__PURE__ */ new Set(["preprocess", "postprocess", "processAllTokens"]);
  preprocess(e) {
    return e;
  }
  postprocess(e) {
    return e;
  }
  processAllTokens(e) {
    return e;
  }
  emStrongMask(e) {
    return e;
  }
  provideLexer(e = this.block) {
    return e ? x.lex : x.lexInline;
  }
  provideParser(e = this.block) {
    return e ? b.parse : b.parseInline;
  }
};
var q = class {
  defaults = M();
  options = this.setOptions;
  parse = this.parseMarkdown(true);
  parseInline = this.parseMarkdown(false);
  Parser = b;
  Renderer = y;
  TextRenderer = L;
  Lexer = x;
  Tokenizer = w;
  Hooks = P;
  constructor(...e) {
    this.use(...e);
  }
  walkTokens(e, t) {
    let n = [];
    for (let s of e) switch (n = n.concat(t.call(this, s)), s.type) {
      case "table": {
        let r = s;
        for (let i of r.header) n = n.concat(this.walkTokens(i.tokens, t));
        for (let i of r.rows) for (let o of i) n = n.concat(this.walkTokens(o.tokens, t));
        break;
      }
      case "list": {
        let r = s;
        n = n.concat(this.walkTokens(r.items, t));
        break;
      }
      default: {
        let r = s;
        this.defaults.extensions?.childTokens?.[r.type] ? this.defaults.extensions.childTokens[r.type].forEach((i) => {
          let o = r[i].flat(1 / 0);
          n = n.concat(this.walkTokens(o, t));
        }) : r.tokens && (n = n.concat(this.walkTokens(r.tokens, t)));
      }
    }
    return n;
  }
  use(...e) {
    let t = this.defaults.extensions || { renderers: {}, childTokens: {} };
    return e.forEach((n) => {
      let s = { ...n };
      if (s.async = this.defaults.async || s.async || false, n.extensions && (n.extensions.forEach((r) => {
        if (!r.name) throw new Error("extension name required");
        if ("renderer" in r) {
          let i = t.renderers[r.name];
          i ? t.renderers[r.name] = function(...o) {
            let u = r.renderer.apply(this, o);
            return u === false && (u = i.apply(this, o)), u;
          } : t.renderers[r.name] = r.renderer;
        }
        if ("tokenizer" in r) {
          if (!r.level || r.level !== "block" && r.level !== "inline") throw new Error("extension level must be 'block' or 'inline'");
          let i = t[r.level];
          i ? i.unshift(r.tokenizer) : t[r.level] = [r.tokenizer], r.start && (r.level === "block" ? t.startBlock ? t.startBlock.push(r.start) : t.startBlock = [r.start] : r.level === "inline" && (t.startInline ? t.startInline.push(r.start) : t.startInline = [r.start]));
        }
        "childTokens" in r && r.childTokens && (t.childTokens[r.name] = r.childTokens);
      }), s.extensions = t), n.renderer) {
        let r = this.defaults.renderer || new y(this.defaults);
        for (let i in n.renderer) {
          if (!(i in r)) throw new Error(`renderer '${i}' does not exist`);
          if (["options", "parser"].includes(i)) continue;
          let o = i, u = n.renderer[o], a = r[o];
          r[o] = (...c) => {
            let p = u.apply(r, c);
            return p === false && (p = a.apply(r, c)), p || "";
          };
        }
        s.renderer = r;
      }
      if (n.tokenizer) {
        let r = this.defaults.tokenizer || new w(this.defaults);
        for (let i in n.tokenizer) {
          if (!(i in r)) throw new Error(`tokenizer '${i}' does not exist`);
          if (["options", "rules", "lexer"].includes(i)) continue;
          let o = i, u = n.tokenizer[o], a = r[o];
          r[o] = (...c) => {
            let p = u.apply(r, c);
            return p === false && (p = a.apply(r, c)), p;
          };
        }
        s.tokenizer = r;
      }
      if (n.hooks) {
        let r = this.defaults.hooks || new P();
        for (let i in n.hooks) {
          if (!(i in r)) throw new Error(`hook '${i}' does not exist`);
          if (["options", "block"].includes(i)) continue;
          let o = i, u = n.hooks[o], a = r[o];
          P.passThroughHooks.has(i) ? r[o] = (c) => {
            if (this.defaults.async && P.passThroughHooksRespectAsync.has(i)) return (async () => {
              let k = await u.call(r, c);
              return a.call(r, k);
            })();
            let p = u.call(r, c);
            return a.call(r, p);
          } : r[o] = (...c) => {
            if (this.defaults.async) return (async () => {
              let k = await u.apply(r, c);
              return k === false && (k = await a.apply(r, c)), k;
            })();
            let p = u.apply(r, c);
            return p === false && (p = a.apply(r, c)), p;
          };
        }
        s.hooks = r;
      }
      if (n.walkTokens) {
        let r = this.defaults.walkTokens, i = n.walkTokens;
        s.walkTokens = function(o) {
          let u = [];
          return u.push(i.call(this, o)), r && (u = u.concat(r.call(this, o))), u;
        };
      }
      this.defaults = { ...this.defaults, ...s };
    }), this;
  }
  setOptions(e) {
    return this.defaults = { ...this.defaults, ...e }, this;
  }
  lexer(e, t) {
    return x.lex(e, t ?? this.defaults);
  }
  parser(e, t) {
    return b.parse(e, t ?? this.defaults);
  }
  parseMarkdown(e) {
    return (n, s) => {
      let r = { ...s }, i = { ...this.defaults, ...r }, o = this.onError(!!i.silent, !!i.async);
      if (this.defaults.async === true && r.async === false) return o(new Error("marked(): The async option was set to true by an extension. Remove async: false from the parse options object to return a Promise."));
      if (typeof n > "u" || n === null) return o(new Error("marked(): input parameter is undefined or null"));
      if (typeof n != "string") return o(new Error("marked(): input parameter is of type " + Object.prototype.toString.call(n) + ", string expected"));
      if (i.hooks && (i.hooks.options = i, i.hooks.block = e), i.async) return (async () => {
        let u = i.hooks ? await i.hooks.preprocess(n) : n, c = await (i.hooks ? await i.hooks.provideLexer(e) : e ? x.lex : x.lexInline)(u, i), p = i.hooks ? await i.hooks.processAllTokens(c) : c;
        i.walkTokens && await Promise.all(this.walkTokens(p, i.walkTokens));
        let h = await (i.hooks ? await i.hooks.provideParser(e) : e ? b.parse : b.parseInline)(p, i);
        return i.hooks ? await i.hooks.postprocess(h) : h;
      })().catch(o);
      try {
        i.hooks && (n = i.hooks.preprocess(n));
        let a = (i.hooks ? i.hooks.provideLexer(e) : e ? x.lex : x.lexInline)(n, i);
        i.hooks && (a = i.hooks.processAllTokens(a)), i.walkTokens && this.walkTokens(a, i.walkTokens);
        let p = (i.hooks ? i.hooks.provideParser(e) : e ? b.parse : b.parseInline)(a, i);
        return i.hooks && (p = i.hooks.postprocess(p)), p;
      } catch (u) {
        return o(u);
      }
    };
  }
  onError(e, t) {
    return (n) => {
      if (n.message += `
Please report this to https://github.com/markedjs/marked.`, e) {
        let s = "<p>An error occurred:</p><pre>" + O(n.message + "", true) + "</pre>";
        return t ? Promise.resolve(s) : s;
      }
      if (t) return Promise.reject(n);
      throw n;
    };
  }
};
var z = new q();
function g(l3, e) {
  return z.parse(l3, e);
}
g.options = g.setOptions = function(l3) {
  return z.setOptions(l3), g.defaults = z.defaults, N(g.defaults), g;
};
g.getDefaults = M;
g.defaults = T;
g.use = function(...l3) {
  return z.use(...l3), g.defaults = z.defaults, N(g.defaults), g;
};
g.walkTokens = function(l3, e) {
  return z.walkTokens(l3, e);
};
g.parseInline = z.parseInline;
g.Parser = b;
g.parser = b.parse;
g.Renderer = y;
g.TextRenderer = L;
g.Lexer = x;
g.lexer = x.lex;
g.Tokenizer = w;
g.Hooks = P;
g.parse = g;
var Ft = g.options;
var Ut = g.setOptions;
var Kt = g.use;
var Wt = g.walkTokens;
var Xt = g.parseInline;
var Vt = b.parse;
var Yt = x.lex;

// node_modules/@earendil-works/pi-tui/dist/fuzzy.js
function fuzzyMatch(query, text) {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();
  const matchQuery = (normalizedQuery) => {
    if (normalizedQuery.length === 0) {
      return { matches: true, score: 0 };
    }
    if (normalizedQuery.length > textLower.length) {
      return { matches: false, score: 0 };
    }
    let queryIndex = 0;
    let score = 0;
    let lastMatchIndex = -1;
    let consecutiveMatches = 0;
    for (let i = 0; i < textLower.length && queryIndex < normalizedQuery.length; i++) {
      if (textLower[i] === normalizedQuery[queryIndex]) {
        const isWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1]);
        if (lastMatchIndex === i - 1) {
          consecutiveMatches++;
          score -= consecutiveMatches * 5;
        } else {
          consecutiveMatches = 0;
          if (lastMatchIndex >= 0) {
            score += (i - lastMatchIndex - 1) * 2;
          }
        }
        if (isWordBoundary) {
          score -= 10;
        }
        score += i * 0.1;
        lastMatchIndex = i;
        queryIndex++;
      }
    }
    if (queryIndex < normalizedQuery.length) {
      return { matches: false, score: 0 };
    }
    if (normalizedQuery === textLower) {
      score -= 100;
    }
    return { matches: true, score };
  };
  const primaryMatch = matchQuery(queryLower);
  if (primaryMatch.matches) {
    return primaryMatch;
  }
  const alphaNumericMatch = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
  const numericAlphaMatch = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
  const swappedQuery = alphaNumericMatch ? `${alphaNumericMatch.groups?.digits ?? ""}${alphaNumericMatch.groups?.letters ?? ""}` : numericAlphaMatch ? `${numericAlphaMatch.groups?.letters ?? ""}${numericAlphaMatch.groups?.digits ?? ""}` : "";
  if (!swappedQuery) {
    return primaryMatch;
  }
  const swappedMatch = matchQuery(swappedQuery);
  if (!swappedMatch.matches) {
    return primaryMatch;
  }
  return { matches: true, score: swappedMatch.score + 5 };
}
function fuzzyFilter(items, query, getText) {
  if (!query.trim()) {
    return items;
  }
  const tokens = query.trim().split(/[\s/]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return items;
  }
  const results = [];
  for (const item of items) {
    const text = getText(item);
    let totalScore = 0;
    let allMatch = true;
    for (const token of tokens) {
      const match = fuzzyMatch(token, text);
      if (match.matches) {
        totalScore += match.score;
      } else {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      results.push({ item, totalScore });
    }
  }
  results.sort((a, b2) => a.totalScore - b2.totalScore);
  return results.map((r) => r.item);
}

// node_modules/get-east-asian-width/lookup-data.js
var ambiguousMinimalCodePoint = 161;
var ambiguousMaximumCodePoint = 1114109;
var ambiguousRanges = [161, 161, 164, 164, 167, 168, 170, 170, 173, 174, 176, 180, 182, 186, 188, 191, 198, 198, 208, 208, 215, 216, 222, 225, 230, 230, 232, 234, 236, 237, 240, 240, 242, 243, 247, 250, 252, 252, 254, 254, 257, 257, 273, 273, 275, 275, 283, 283, 294, 295, 299, 299, 305, 307, 312, 312, 319, 322, 324, 324, 328, 331, 333, 333, 338, 339, 358, 359, 363, 363, 462, 462, 464, 464, 466, 466, 468, 468, 470, 470, 472, 472, 474, 474, 476, 476, 593, 593, 609, 609, 708, 708, 711, 711, 713, 715, 717, 717, 720, 720, 728, 731, 733, 733, 735, 735, 768, 879, 913, 929, 931, 937, 945, 961, 963, 969, 1025, 1025, 1040, 1103, 1105, 1105, 8208, 8208, 8211, 8214, 8216, 8217, 8220, 8221, 8224, 8226, 8228, 8231, 8240, 8240, 8242, 8243, 8245, 8245, 8251, 8251, 8254, 8254, 8308, 8308, 8319, 8319, 8321, 8324, 8364, 8364, 8451, 8451, 8453, 8453, 8457, 8457, 8467, 8467, 8470, 8470, 8481, 8482, 8486, 8486, 8491, 8491, 8531, 8532, 8539, 8542, 8544, 8555, 8560, 8569, 8585, 8585, 8592, 8601, 8632, 8633, 8658, 8658, 8660, 8660, 8679, 8679, 8704, 8704, 8706, 8707, 8711, 8712, 8715, 8715, 8719, 8719, 8721, 8721, 8725, 8725, 8730, 8730, 8733, 8736, 8739, 8739, 8741, 8741, 8743, 8748, 8750, 8750, 8756, 8759, 8764, 8765, 8776, 8776, 8780, 8780, 8786, 8786, 8800, 8801, 8804, 8807, 8810, 8811, 8814, 8815, 8834, 8835, 8838, 8839, 8853, 8853, 8857, 8857, 8869, 8869, 8895, 8895, 8978, 8978, 9312, 9449, 9451, 9547, 9552, 9587, 9600, 9615, 9618, 9621, 9632, 9633, 9635, 9641, 9650, 9651, 9654, 9655, 9660, 9661, 9664, 9665, 9670, 9672, 9675, 9675, 9678, 9681, 9698, 9701, 9711, 9711, 9733, 9734, 9737, 9737, 9742, 9743, 9756, 9756, 9758, 9758, 9792, 9792, 9794, 9794, 9824, 9825, 9827, 9829, 9831, 9834, 9836, 9837, 9839, 9839, 9886, 9887, 9919, 9919, 9926, 9933, 9935, 9939, 9941, 9953, 9955, 9955, 9960, 9961, 9963, 9969, 9972, 9972, 9974, 9977, 9979, 9980, 9982, 9983, 10045, 10045, 10102, 10111, 11094, 11097, 12872, 12879, 57344, 63743, 65024, 65039, 65533, 65533, 127232, 127242, 127248, 127277, 127280, 127337, 127344, 127373, 127375, 127376, 127387, 127404, 917760, 917999, 983040, 1048573, 1048576, 1114109];
var fullwidthMinimalCodePoint = 12288;
var fullwidthMaximumCodePoint = 65510;
var fullwidthRanges = [12288, 12288, 65281, 65376, 65504, 65510];
var wideMinimalCodePoint = 4352;
var wideMaximumCodePoint = 262141;
var wideRanges = [4352, 4447, 8986, 8987, 9001, 9002, 9193, 9196, 9200, 9200, 9203, 9203, 9725, 9726, 9748, 9749, 9776, 9783, 9800, 9811, 9855, 9855, 9866, 9871, 9875, 9875, 9889, 9889, 9898, 9899, 9917, 9918, 9924, 9925, 9934, 9934, 9940, 9940, 9962, 9962, 9970, 9971, 9973, 9973, 9978, 9978, 9981, 9981, 9989, 9989, 9994, 9995, 10024, 10024, 10060, 10060, 10062, 10062, 10067, 10069, 10071, 10071, 10133, 10135, 10160, 10160, 10175, 10175, 11035, 11036, 11088, 11088, 11093, 11093, 11904, 11929, 11931, 12019, 12032, 12245, 12272, 12287, 12289, 12350, 12353, 12438, 12441, 12543, 12549, 12591, 12593, 12686, 12688, 12773, 12783, 12830, 12832, 12871, 12880, 42124, 42128, 42182, 43360, 43388, 44032, 55203, 63744, 64255, 65040, 65049, 65072, 65106, 65108, 65126, 65128, 65131, 94176, 94180, 94192, 94198, 94208, 101589, 101631, 101662, 101760, 101874, 110576, 110579, 110581, 110587, 110589, 110590, 110592, 110882, 110898, 110898, 110928, 110930, 110933, 110933, 110948, 110951, 110960, 111355, 119552, 119638, 119648, 119670, 126980, 126980, 127183, 127183, 127374, 127374, 127377, 127386, 127488, 127490, 127504, 127547, 127552, 127560, 127568, 127569, 127584, 127589, 127744, 127776, 127789, 127797, 127799, 127868, 127870, 127891, 127904, 127946, 127951, 127955, 127968, 127984, 127988, 127988, 127992, 128062, 128064, 128064, 128066, 128252, 128255, 128317, 128331, 128334, 128336, 128359, 128378, 128378, 128405, 128406, 128420, 128420, 128507, 128591, 128640, 128709, 128716, 128716, 128720, 128722, 128725, 128728, 128732, 128735, 128747, 128748, 128756, 128764, 128992, 129003, 129008, 129008, 129292, 129338, 129340, 129349, 129351, 129535, 129648, 129660, 129664, 129674, 129678, 129734, 129736, 129736, 129741, 129756, 129759, 129770, 129775, 129784, 131072, 196605, 196608, 262141];

// node_modules/get-east-asian-width/utilities.js
var isInRange = (ranges, codePoint) => {
  let low = 0;
  let high = Math.floor(ranges.length / 2) - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const i = mid * 2;
    if (codePoint < ranges[i]) {
      high = mid - 1;
    } else if (codePoint > ranges[i + 1]) {
      low = mid + 1;
    } else {
      return true;
    }
  }
  return false;
};

// node_modules/get-east-asian-width/lookup.js
var commonCjkCodePoint = 19968;
var [wideFastPathStart, wideFastPathEnd] = /* @__PURE__ */ findWideFastPathRange(wideRanges);
function findWideFastPathRange(ranges) {
  let fastPathStart = ranges[0];
  let fastPathEnd = ranges[1];
  for (let index = 0; index < ranges.length; index += 2) {
    const start = ranges[index];
    const end = ranges[index + 1];
    if (commonCjkCodePoint >= start && commonCjkCodePoint <= end) {
      return [start, end];
    }
    if (end - start > fastPathEnd - fastPathStart) {
      fastPathStart = start;
      fastPathEnd = end;
    }
  }
  return [fastPathStart, fastPathEnd];
}
var isAmbiguous = (codePoint) => {
  if (codePoint < ambiguousMinimalCodePoint || codePoint > ambiguousMaximumCodePoint) {
    return false;
  }
  return isInRange(ambiguousRanges, codePoint);
};
var isFullWidth = (codePoint) => {
  if (codePoint < fullwidthMinimalCodePoint || codePoint > fullwidthMaximumCodePoint) {
    return false;
  }
  return isInRange(fullwidthRanges, codePoint);
};
var isWide = (codePoint) => {
  if (codePoint >= wideFastPathStart && codePoint <= wideFastPathEnd) {
    return true;
  }
  if (codePoint < wideMinimalCodePoint || codePoint > wideMaximumCodePoint) {
    return false;
  }
  return isInRange(wideRanges, codePoint);
};

// node_modules/get-east-asian-width/index.js
function validate(codePoint) {
  if (!Number.isSafeInteger(codePoint)) {
    throw new TypeError(`Expected a code point, got \`${typeof codePoint}\`.`);
  }
}
function eastAsianWidth(codePoint, { ambiguousAsWide = false } = {}) {
  validate(codePoint);
  if (isFullWidth(codePoint) || isWide(codePoint) || ambiguousAsWide && isAmbiguous(codePoint)) {
    return 2;
  }
  return 1;
}

// node_modules/@earendil-works/pi-tui/dist/utils.js
var graphemeSegmenter = new Intl.Segmenter(void 0, { granularity: "grapheme" });
var wordSegmenter = new Intl.Segmenter(void 0, { granularity: "word" });
function getGraphemeSegmenter() {
  return graphemeSegmenter;
}
function getWordSegmenter() {
  return wordSegmenter;
}
function couldBeEmoji(segment) {
  const cp = segment.codePointAt(0);
  return cp >= 126976 && cp <= 130047 || // Emoji and Pictograph
  cp >= 8960 && cp <= 9215 || // Misc technical
  cp >= 9728 && cp <= 10175 || // Misc symbols, dingbats
  cp >= 11088 && cp <= 11093 || // Specific stars/circles
  segment.includes("\uFE0F") || // Contains VS16 (emoji presentation selector)
  segment.length > 2;
}
var zeroWidthRegex = new RegExp("^(?:\\p{Default_Ignorable_Code_Point}|\\p{Control}|\\p{Mark}|\\p{Surrogate})+$", "v");
var leadingNonPrintingRegex = new RegExp("^[\\p{Default_Ignorable_Code_Point}\\p{Control}\\p{Format}\\p{Mark}\\p{Surrogate}]+", "v");
var nonPrintingCharRegex = new RegExp("^(?:\\p{Default_Ignorable_Code_Point}|\\p{Control}|\\p{Format}|\\p{Mark}|\\p{Surrogate})$", "v");
var markCharRegex = new RegExp("^\\p{Mark}$", "v");
var terminalSpacingMarkRegex = new RegExp("^(?:[\\p{Spacing_Mark}--[\\u1734\\u302E\\u302F]]|[\\u065F\\u0F7F\\u102B\\u102C\\u1031\\u1033-\\u1035\\u1038\\u103A-\\u103E])+$", "v");
var rgiEmojiRegex = new RegExp("^\\p{RGI_Emoji}$", "v");
var WIDTH_CACHE_SIZE = 512;
var widthCache = /* @__PURE__ */ new Map();
var cjkBreakRegex = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;
function isPrintableAscii(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 32 || code > 126) {
      return false;
    }
  }
  return true;
}
function truncateFragmentToWidth(text, maxWidth) {
  if (maxWidth <= 0 || text.length === 0) {
    return { text: "", width: 0 };
  }
  if (isPrintableAscii(text)) {
    const clipped = text.slice(0, maxWidth);
    return { text: clipped, width: clipped.length };
  }
  const hasAnsi = text.includes("\x1B");
  const hasTabs = text.includes("	");
  if (!hasAnsi && !hasTabs) {
    let result2 = "";
    let width2 = 0;
    for (const { segment } of graphemeSegmenter.segment(text)) {
      const w2 = graphemeWidth(segment);
      if (width2 + w2 > maxWidth) {
        break;
      }
      result2 += segment;
      width2 += w2;
    }
    return { text: result2, width: width2 };
  }
  let result = "";
  let width = 0;
  let i = 0;
  let pendingAnsi = "";
  while (i < text.length) {
    const ansi = extractAnsiCode(text, i);
    if (ansi) {
      pendingAnsi += ansi.code;
      i += ansi.length;
      continue;
    }
    if (text[i] === "	") {
      if (width + 3 > maxWidth) {
        break;
      }
      if (pendingAnsi) {
        result += pendingAnsi;
        pendingAnsi = "";
      }
      result += "	";
      width += 3;
      i++;
      continue;
    }
    let end = i;
    while (end < text.length && text[end] !== "	") {
      const nextAnsi = extractAnsiCode(text, end);
      if (nextAnsi) {
        break;
      }
      end++;
    }
    for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
      const w2 = graphemeWidth(segment);
      if (width + w2 > maxWidth) {
        return { text: result, width };
      }
      if (pendingAnsi) {
        result += pendingAnsi;
        pendingAnsi = "";
      }
      result += segment;
      width += w2;
    }
    i = end;
  }
  return { text: result, width };
}
function finalizeTruncatedResult(prefix, prefixWidth, ellipsis, ellipsisWidth, maxWidth, pad2) {
  const reset = "\x1B[0m";
  const hyperlinkClose = getActiveOsc8Close(prefix);
  const visibleWidth2 = prefixWidth + ellipsisWidth;
  let result;
  if (ellipsis.length > 0) {
    result = `${prefix}${hyperlinkClose}${reset}${ellipsis}${reset}`;
  } else {
    result = `${prefix}${hyperlinkClose}${reset}`;
  }
  return pad2 ? result + " ".repeat(Math.max(0, maxWidth - visibleWidth2)) : result;
}
function graphemeWidth(segment) {
  if (segment === "	") {
    return 3;
  }
  if (terminalSpacingMarkRegex.test(segment)) {
    return [...segment].length;
  }
  if (zeroWidthRegex.test(segment)) {
    return 0;
  }
  if (couldBeEmoji(segment) && rgiEmojiRegex.test(segment)) {
    return 2;
  }
  const base = segment.replace(leadingNonPrintingRegex, "");
  const cp = base.codePointAt(0);
  if (cp === void 0) {
    return 0;
  }
  if (cp >= 127462 && cp <= 127487) {
    return 2;
  }
  let width = eastAsianWidth(cp);
  let followsMark = false;
  const chars = [...base];
  for (const char of chars.slice(1)) {
    if (terminalSpacingMarkRegex.test(char)) {
      width += 1;
      followsMark = false;
    } else if (markCharRegex.test(char)) {
      followsMark = true;
    } else if (!nonPrintingCharRegex.test(char)) {
      const c = char.codePointAt(0);
      if (followsMark || c >= 65280 && c <= 65519) {
        width += eastAsianWidth(c);
      } else if (c === 3635 || c === 3763) {
        width += 1;
      }
      followsMark = false;
    }
  }
  return width;
}
function visibleWidth(str) {
  if (str.length === 0) {
    return 0;
  }
  if (isPrintableAscii(str)) {
    return str.length;
  }
  const cached = widthCache.get(str);
  if (cached !== void 0) {
    return cached;
  }
  let clean = str;
  if (str.includes("	")) {
    clean = clean.replace(/\t/g, "   ");
  }
  if (clean.includes("\x1B")) {
    let stripped = "";
    let i = 0;
    while (i < clean.length) {
      const ansi = extractAnsiCode(clean, i);
      if (ansi) {
        i += ansi.length;
        continue;
      }
      stripped += clean[i];
      i++;
    }
    clean = stripped;
  }
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(clean)) {
    width += graphemeWidth(segment);
  }
  if (widthCache.size >= WIDTH_CACHE_SIZE) {
    const firstKey = widthCache.keys().next().value;
    if (firstKey !== void 0) {
      widthCache.delete(firstKey);
    }
  }
  widthCache.set(str, width);
  return width;
}
function stripTerminalSequences(str) {
  if (!str.includes("\x1B"))
    return str;
  let result = "";
  let i = 0;
  while (i < str.length) {
    const ansi = extractAnsiCode(str, i);
    if (ansi) {
      i += ansi.length;
      continue;
    }
    result += str[i];
    i++;
  }
  return result;
}
function getGraphemeCellRange(line, column) {
  let currentCol = 0;
  let i = 0;
  while (i < line.length) {
    const ansi = extractAnsiCode(line, i);
    if (ansi) {
      i += ansi.length;
      continue;
    }
    let textEnd = i;
    while (textEnd < line.length && !extractAnsiCode(line, textEnd))
      textEnd++;
    for (const { segment } of graphemeSegmenter.segment(line.slice(i, textEnd))) {
      const width = graphemeWidth(segment);
      if (width > 0 && column >= currentCol && column < currentCol + width) {
        return { start: currentCol, end: currentCol + width };
      }
      currentCol += width;
    }
    i = textEnd;
  }
  return void 0;
}
function getOsc8LinkAtColumn(line, column) {
  let activeUrl;
  let currentCol = 0;
  let i = 0;
  while (i < line.length) {
    const ansi = extractAnsiCode(line, i);
    if (ansi) {
      const hyperlink2 = /^\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)$/.exec(ansi.code);
      if (hyperlink2)
        activeUrl = hyperlink2[1] || void 0;
      i += ansi.length;
      continue;
    }
    let textEnd = i;
    while (textEnd < line.length && !extractAnsiCode(line, textEnd))
      textEnd++;
    for (const { segment } of graphemeSegmenter.segment(line.slice(i, textEnd))) {
      const width = segment === "	" ? 3 : graphemeWidth(segment);
      if (column >= currentCol && column < currentCol + width)
        return activeUrl;
      currentCol += width;
    }
    i = textEnd;
  }
  return void 0;
}
var THAI_LAO_AM_REGEX = /[\u0e33\u0eb3]/;
var THAI_LAO_AM_GLOBAL_REGEX = /[\u0e33\u0eb3]/g;
function normalizeTerminalOutput(str) {
  let normalized = str;
  if (THAI_LAO_AM_REGEX.test(normalized)) {
    normalized = normalized.replace(THAI_LAO_AM_GLOBAL_REGEX, (char) => char === "\u0E33" ? "\u0E4D\u0E32" : "\u0ECD\u0EB2");
  }
  if (!normalized.includes("	"))
    return normalized;
  let result = "";
  let i = 0;
  while (i < normalized.length) {
    const ansi = extractAnsiCode(normalized, i);
    if (ansi) {
      result += ansi.code;
      i += ansi.length;
      continue;
    }
    result += normalized[i] === "	" ? "   " : normalized[i];
    i++;
  }
  return result;
}
function extractAnsiCode(str, pos) {
  if (pos >= str.length || str[pos] !== "\x1B")
    return null;
  const next = str[pos + 1];
  if (next === "[") {
    let j2 = pos + 2;
    while (j2 < str.length && !/[mGKHJ]/.test(str[j2]))
      j2++;
    if (j2 < str.length)
      return { code: str.substring(pos, j2 + 1), length: j2 + 1 - pos };
    return null;
  }
  if (next === "]") {
    let j2 = pos + 2;
    while (j2 < str.length) {
      if (str[j2] === "\x07")
        return { code: str.substring(pos, j2 + 1), length: j2 + 1 - pos };
      if (str[j2] === "\x1B" && str[j2 + 1] === "\\")
        return { code: str.substring(pos, j2 + 2), length: j2 + 2 - pos };
      j2++;
    }
    return null;
  }
  if (next === "_") {
    let j2 = pos + 2;
    while (j2 < str.length) {
      if (str[j2] === "\x07")
        return { code: str.substring(pos, j2 + 1), length: j2 + 1 - pos };
      if (str[j2] === "\x1B" && str[j2 + 1] === "\\")
        return { code: str.substring(pos, j2 + 2), length: j2 + 2 - pos };
      j2++;
    }
    return null;
  }
  return null;
}
function parseOsc8Hyperlink(ansiCode) {
  if (!ansiCode.startsWith("\x1B]8;")) {
    return void 0;
  }
  const terminator = ansiCode.endsWith("\x07") ? "\x07" : "\x1B\\";
  const body = ansiCode.slice(4, terminator === "\x07" ? -1 : -2);
  const separatorIndex = body.indexOf(";");
  if (separatorIndex === -1) {
    return void 0;
  }
  const params = body.slice(0, separatorIndex);
  const url = body.slice(separatorIndex + 1);
  if (!url) {
    return null;
  }
  return { params, url, terminator };
}
function formatOsc8Hyperlink(hyperlink2) {
  return `\x1B]8;${hyperlink2.params};${hyperlink2.url}${hyperlink2.terminator}`;
}
function formatOsc8Close(terminator) {
  return `\x1B]8;;${terminator}`;
}
function getActiveOsc8Close(prefix) {
  if (!prefix.includes("\x1B]8;")) {
    return "";
  }
  let activeHyperlink = null;
  let i = 0;
  while (i < prefix.length) {
    const ansi = extractAnsiCode(prefix, i);
    if (ansi) {
      const hyperlink2 = parseOsc8Hyperlink(ansi.code);
      if (hyperlink2 !== void 0) {
        activeHyperlink = hyperlink2;
      }
      i += ansi.length;
    } else {
      i++;
    }
  }
  return activeHyperlink ? formatOsc8Close(activeHyperlink.terminator) : "";
}
var AnsiCodeTracker = class {
  // Track individual attributes separately so we can reset them specifically
  bold = false;
  dim = false;
  italic = false;
  underline = false;
  blink = false;
  inverse = false;
  hidden = false;
  strikethrough = false;
  fgColor = null;
  // Stores the full code like "31" or "38;5;240"
  bgColor = null;
  // Stores the full code like "41" or "48;5;240"
  activeHyperlink = null;
  process(ansiCode) {
    const hyperlink2 = parseOsc8Hyperlink(ansiCode);
    if (hyperlink2 !== void 0) {
      this.activeHyperlink = hyperlink2;
      return;
    }
    if (!ansiCode.endsWith("m")) {
      return;
    }
    const match = ansiCode.match(/\x1b\[([\d;]*)m/);
    if (!match)
      return;
    const params = match[1];
    if (params === "" || params === "0") {
      this.reset();
      return;
    }
    const parts = params.split(";");
    let i = 0;
    while (i < parts.length) {
      const code = Number.parseInt(parts[i], 10);
      if (code === 38 || code === 48) {
        if (parts[i + 1] === "5" && parts[i + 2] !== void 0) {
          const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]}`;
          if (code === 38) {
            this.fgColor = colorCode;
          } else {
            this.bgColor = colorCode;
          }
          i += 3;
          continue;
        } else if (parts[i + 1] === "2" && parts[i + 4] !== void 0) {
          const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]};${parts[i + 3]};${parts[i + 4]}`;
          if (code === 38) {
            this.fgColor = colorCode;
          } else {
            this.bgColor = colorCode;
          }
          i += 5;
          continue;
        }
      }
      switch (code) {
        case 0:
          this.reset();
          break;
        case 1:
          this.bold = true;
          break;
        case 2:
          this.dim = true;
          break;
        case 3:
          this.italic = true;
          break;
        case 4:
          this.underline = true;
          break;
        case 5:
          this.blink = true;
          break;
        case 7:
          this.inverse = true;
          break;
        case 8:
          this.hidden = true;
          break;
        case 9:
          this.strikethrough = true;
          break;
        case 21:
          this.bold = false;
          break;
        // Some terminals
        case 22:
          this.bold = false;
          this.dim = false;
          break;
        case 23:
          this.italic = false;
          break;
        case 24:
          this.underline = false;
          break;
        case 25:
          this.blink = false;
          break;
        case 27:
          this.inverse = false;
          break;
        case 28:
          this.hidden = false;
          break;
        case 29:
          this.strikethrough = false;
          break;
        case 39:
          this.fgColor = null;
          break;
        // Default fg
        case 49:
          this.bgColor = null;
          break;
        // Default bg
        default:
          if (code >= 30 && code <= 37 || code >= 90 && code <= 97) {
            this.fgColor = String(code);
          } else if (code >= 40 && code <= 47 || code >= 100 && code <= 107) {
            this.bgColor = String(code);
          }
          break;
      }
      i++;
    }
  }
  reset() {
    this.bold = false;
    this.dim = false;
    this.italic = false;
    this.underline = false;
    this.blink = false;
    this.inverse = false;
    this.hidden = false;
    this.strikethrough = false;
    this.fgColor = null;
    this.bgColor = null;
  }
  /** Clear all state for reuse. */
  clear() {
    this.reset();
    this.activeHyperlink = null;
  }
  getActiveCodes() {
    const codes = [];
    if (this.bold)
      codes.push("1");
    if (this.dim)
      codes.push("2");
    if (this.italic)
      codes.push("3");
    if (this.underline)
      codes.push("4");
    if (this.blink)
      codes.push("5");
    if (this.inverse)
      codes.push("7");
    if (this.hidden)
      codes.push("8");
    if (this.strikethrough)
      codes.push("9");
    if (this.fgColor)
      codes.push(this.fgColor);
    if (this.bgColor)
      codes.push(this.bgColor);
    let result = codes.length > 0 ? `\x1B[${codes.join(";")}m` : "";
    if (this.activeHyperlink) {
      result += formatOsc8Hyperlink(this.activeHyperlink);
    }
    return result;
  }
  hasActiveCodes() {
    return this.bold || this.dim || this.italic || this.underline || this.blink || this.inverse || this.hidden || this.strikethrough || this.fgColor !== null || this.bgColor !== null || this.activeHyperlink !== null;
  }
  /**
   * Get reset codes for attributes that need to be turned off at line end.
   * Underline must be closed to prevent bleeding into padding.
   * Active OSC 8 hyperlinks must be closed and re-opened on the next line.
   * Returns empty string if no attributes need closing.
   */
  getLineEndReset() {
    let result = "";
    if (this.underline) {
      result += "\x1B[24m";
    }
    if (this.activeHyperlink) {
      result += formatOsc8Close(this.activeHyperlink.terminator);
    }
    return result;
  }
};
function updateTrackerFromText(text, tracker) {
  let i = 0;
  while (i < text.length) {
    const ansiResult = extractAnsiCode(text, i);
    if (ansiResult) {
      tracker.process(ansiResult.code);
      i += ansiResult.length;
    } else {
      i++;
    }
  }
}
function splitIntoTokensWithAnsi(text) {
  const tokens = [];
  let current = "";
  let pendingAnsi = "";
  let currentKind = null;
  let i = 0;
  const flushCurrent = () => {
    if (!current) {
      return;
    }
    tokens.push(current);
    current = "";
    currentKind = null;
  };
  while (i < text.length) {
    const ansiResult = extractAnsiCode(text, i);
    if (ansiResult) {
      pendingAnsi += ansiResult.code;
      i += ansiResult.length;
      continue;
    }
    let end = i;
    while (end < text.length && !extractAnsiCode(text, end)) {
      end++;
    }
    for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
      const segmentIsSpace = segment === " ";
      if (!segmentIsSpace && cjkBreakRegex.test(segment)) {
        flushCurrent();
        const token = pendingAnsi + segment;
        pendingAnsi = "";
        tokens.push(token);
        continue;
      }
      const segmentKind = segmentIsSpace ? "space" : "word";
      if (current && currentKind !== segmentKind) {
        flushCurrent();
      }
      if (pendingAnsi) {
        current += pendingAnsi;
        pendingAnsi = "";
      }
      currentKind = segmentKind;
      current += segment;
    }
    i = end;
  }
  if (pendingAnsi) {
    if (current) {
      current += pendingAnsi;
    } else if (tokens.length > 0) {
      tokens[tokens.length - 1] += pendingAnsi;
    } else {
      current = pendingAnsi;
    }
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}
function wrapTextWithAnsi(text, width) {
  if (!text) {
    return [""];
  }
  const inputLines = text.split(/\r\n|\r|\n/);
  const result = [];
  const tracker = new AnsiCodeTracker();
  for (const inputLine of inputLines) {
    const prefix = result.length > 0 ? tracker.getActiveCodes() : "";
    const wrappedLines = wrapSingleLine(prefix + inputLine, width);
    for (const wrappedLine of wrappedLines) {
      result.push(wrappedLine);
    }
    updateTrackerFromText(inputLine, tracker);
  }
  return result.length > 0 ? result : [""];
}
function wrapSingleLine(line, width) {
  if (!line) {
    return [""];
  }
  const visibleLength = visibleWidth(line);
  if (visibleLength <= width) {
    return [line];
  }
  const wrapped = [];
  const tracker = new AnsiCodeTracker();
  const tokens = splitIntoTokensWithAnsi(line);
  let currentLine = "";
  let currentVisibleLength = 0;
  for (const token of tokens) {
    const tokenVisibleLength = visibleWidth(token);
    const isWhitespace = token.trim() === "";
    if (tokenVisibleLength > width && !isWhitespace) {
      if (currentLine) {
        const lineEndReset = tracker.getLineEndReset();
        if (lineEndReset) {
          currentLine += lineEndReset;
        }
        wrapped.push(currentLine);
        currentLine = "";
        currentVisibleLength = 0;
      }
      const broken = breakLongWord(token, width, tracker);
      for (let i = 0; i < broken.length - 1; i++) {
        wrapped.push(broken[i]);
      }
      currentLine = broken[broken.length - 1];
      currentVisibleLength = visibleWidth(currentLine);
      continue;
    }
    const totalNeeded = currentVisibleLength + tokenVisibleLength;
    if (totalNeeded > width && currentVisibleLength > 0) {
      let lineToWrap = currentLine.trimEnd();
      const lineEndReset = tracker.getLineEndReset();
      if (lineEndReset) {
        lineToWrap += lineEndReset;
      }
      wrapped.push(lineToWrap);
      if (isWhitespace) {
        currentLine = tracker.getActiveCodes();
        currentVisibleLength = 0;
      } else {
        currentLine = tracker.getActiveCodes() + token;
        currentVisibleLength = tokenVisibleLength;
      }
    } else {
      currentLine += token;
      currentVisibleLength += tokenVisibleLength;
    }
    updateTrackerFromText(token, tracker);
  }
  if (currentLine) {
    wrapped.push(currentLine);
  }
  return wrapped.length > 0 ? wrapped.map((line2) => line2.trimEnd()) : [""];
}
var PUNCTUATION_REGEX = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/;
function isWhitespaceChar(char) {
  return /\s/.test(char);
}
function breakLongWord(word, width, tracker) {
  const lines = [];
  let currentLine = tracker.getActiveCodes();
  let currentWidth = 0;
  let i = 0;
  const segments = [];
  while (i < word.length) {
    const ansiResult = extractAnsiCode(word, i);
    if (ansiResult) {
      segments.push({ type: "ansi", value: ansiResult.code });
      i += ansiResult.length;
    } else {
      let end = i;
      while (end < word.length) {
        const nextAnsi = extractAnsiCode(word, end);
        if (nextAnsi)
          break;
        end++;
      }
      const textPortion = word.slice(i, end);
      for (const seg of graphemeSegmenter.segment(textPortion)) {
        segments.push({ type: "grapheme", value: seg.segment });
      }
      i = end;
    }
  }
  for (const seg of segments) {
    if (seg.type === "ansi") {
      currentLine += seg.value;
      tracker.process(seg.value);
      continue;
    }
    const grapheme = seg.value;
    if (!grapheme)
      continue;
    const graphemeWidth2 = visibleWidth(grapheme);
    if (currentWidth + graphemeWidth2 > width) {
      const lineEndReset = tracker.getLineEndReset();
      if (lineEndReset) {
        currentLine += lineEndReset;
      }
      lines.push(currentLine);
      currentLine = tracker.getActiveCodes();
      currentWidth = 0;
    }
    currentLine += grapheme;
    currentWidth += graphemeWidth2;
  }
  if (currentLine) {
    lines.push(currentLine);
  }
  return lines.length > 0 ? lines : [""];
}
function applyBackgroundToLine(line, width, bgFn) {
  const visibleLen = visibleWidth(line);
  const paddingNeeded = Math.max(0, width - visibleLen);
  const padding = " ".repeat(paddingNeeded);
  const withPadding = line + padding;
  return bgFn(withPadding);
}
function truncateToWidth(text, maxWidth, ellipsis = "...", pad2 = false) {
  if (maxWidth <= 0) {
    return "";
  }
  if (text.length === 0) {
    return pad2 ? " ".repeat(maxWidth) : "";
  }
  const ellipsisWidth = visibleWidth(ellipsis);
  if (ellipsisWidth >= maxWidth) {
    const textWidth = visibleWidth(text);
    if (textWidth <= maxWidth) {
      return pad2 ? text + " ".repeat(maxWidth - textWidth) : text;
    }
    const clippedEllipsis = truncateFragmentToWidth(ellipsis, maxWidth);
    if (clippedEllipsis.width === 0) {
      return pad2 ? " ".repeat(maxWidth) : "";
    }
    return finalizeTruncatedResult("", 0, clippedEllipsis.text, clippedEllipsis.width, maxWidth, pad2);
  }
  if (isPrintableAscii(text)) {
    if (text.length <= maxWidth) {
      return pad2 ? text + " ".repeat(maxWidth - text.length) : text;
    }
    const targetWidth2 = maxWidth - ellipsisWidth;
    return finalizeTruncatedResult(text.slice(0, targetWidth2), targetWidth2, ellipsis, ellipsisWidth, maxWidth, pad2);
  }
  const targetWidth = maxWidth - ellipsisWidth;
  let result = "";
  let pendingAnsi = "";
  let visibleSoFar = 0;
  let keptWidth = 0;
  let keepContiguousPrefix = true;
  let overflowed = false;
  let exhaustedInput = false;
  const hasAnsi = text.includes("\x1B");
  const hasTabs = text.includes("	");
  if (!hasAnsi && !hasTabs) {
    for (const { segment } of graphemeSegmenter.segment(text)) {
      const width = graphemeWidth(segment);
      if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
        result += segment;
        keptWidth += width;
      } else {
        keepContiguousPrefix = false;
      }
      visibleSoFar += width;
      if (visibleSoFar > maxWidth) {
        overflowed = true;
        break;
      }
    }
    exhaustedInput = !overflowed;
  } else {
    let i = 0;
    while (i < text.length) {
      const ansi = extractAnsiCode(text, i);
      if (ansi) {
        pendingAnsi += ansi.code;
        i += ansi.length;
        continue;
      }
      if (text[i] === "	") {
        if (keepContiguousPrefix && keptWidth + 3 <= targetWidth) {
          if (pendingAnsi) {
            result += pendingAnsi;
            pendingAnsi = "";
          }
          result += "	";
          keptWidth += 3;
        } else {
          keepContiguousPrefix = false;
          pendingAnsi = "";
        }
        visibleSoFar += 3;
        if (visibleSoFar > maxWidth) {
          overflowed = true;
          break;
        }
        i++;
        continue;
      }
      let end = i;
      while (end < text.length && text[end] !== "	") {
        const nextAnsi = extractAnsiCode(text, end);
        if (nextAnsi) {
          break;
        }
        end++;
      }
      for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
        const width = graphemeWidth(segment);
        if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
          if (pendingAnsi) {
            result += pendingAnsi;
            pendingAnsi = "";
          }
          result += segment;
          keptWidth += width;
        } else {
          keepContiguousPrefix = false;
          pendingAnsi = "";
        }
        visibleSoFar += width;
        if (visibleSoFar > maxWidth) {
          overflowed = true;
          break;
        }
      }
      if (overflowed) {
        break;
      }
      i = end;
    }
    exhaustedInput = i >= text.length;
  }
  if (!overflowed && exhaustedInput) {
    return pad2 ? text + " ".repeat(Math.max(0, maxWidth - visibleSoFar)) : text;
  }
  return finalizeTruncatedResult(result, keptWidth, ellipsis, ellipsisWidth, maxWidth, pad2);
}
function sliceByColumn(line, startCol, length, strict = false) {
  return sliceWithWidth(line, startCol, length, strict).text;
}
function sliceWithWidth(line, startCol, length, strict = false) {
  if (length <= 0)
    return { text: "", width: 0 };
  const endCol = startCol + length;
  let result = "", resultWidth = 0, currentCol = 0, i = 0, pendingAnsi = "";
  while (i < line.length) {
    const ansi = extractAnsiCode(line, i);
    if (ansi) {
      if (currentCol >= startCol && currentCol < endCol)
        result += ansi.code;
      else if (currentCol < startCol)
        pendingAnsi += ansi.code;
      i += ansi.length;
      continue;
    }
    let textEnd = i;
    while (textEnd < line.length && !extractAnsiCode(line, textEnd))
      textEnd++;
    for (const { segment } of graphemeSegmenter.segment(line.slice(i, textEnd))) {
      const w2 = graphemeWidth(segment);
      const inRange = currentCol >= startCol && currentCol < endCol;
      const fits = !strict || currentCol + w2 <= endCol;
      if (inRange && fits) {
        if (pendingAnsi) {
          result += pendingAnsi;
          pendingAnsi = "";
        }
        result += segment;
        resultWidth += w2;
      }
      currentCol += w2;
      if (currentCol >= endCol)
        break;
    }
    i = textEnd;
    if (currentCol >= endCol)
      break;
  }
  return { text: result, width: resultWidth };
}
var pooledStyleTracker = new AnsiCodeTracker();
function extractSegments(line, beforeEnd, afterStart, afterLen, strictAfter = false) {
  let before = "", beforeWidth = 0, after = "", afterWidth = 0;
  let currentCol = 0, i = 0;
  let pendingAnsiBefore = "";
  let afterStarted = false;
  const afterEnd = afterStart + afterLen;
  pooledStyleTracker.clear();
  while (i < line.length) {
    const ansi = extractAnsiCode(line, i);
    if (ansi) {
      pooledStyleTracker.process(ansi.code);
      if (currentCol < beforeEnd) {
        pendingAnsiBefore += ansi.code;
      } else if (currentCol >= afterStart && currentCol < afterEnd && afterStarted) {
        after += ansi.code;
      }
      i += ansi.length;
      continue;
    }
    let textEnd = i;
    while (textEnd < line.length && !extractAnsiCode(line, textEnd))
      textEnd++;
    for (const { segment } of graphemeSegmenter.segment(line.slice(i, textEnd))) {
      const w2 = graphemeWidth(segment);
      if (currentCol < beforeEnd && currentCol + w2 <= beforeEnd) {
        if (pendingAnsiBefore) {
          before += pendingAnsiBefore;
          pendingAnsiBefore = "";
        }
        before += segment;
        beforeWidth += w2;
      } else if (currentCol >= afterStart && currentCol < afterEnd) {
        const fits = !strictAfter || currentCol + w2 <= afterEnd;
        if (fits) {
          if (!afterStarted) {
            after += pooledStyleTracker.getActiveCodes();
            afterStarted = true;
          }
          after += segment;
          afterWidth += w2;
        }
      }
      currentCol += w2;
      if (afterLen <= 0 ? currentCol >= beforeEnd : currentCol >= afterEnd)
        break;
    }
    i = textEnd;
    if (afterLen <= 0 ? currentCol >= beforeEnd : currentCol >= afterEnd)
      break;
  }
  return { before, beforeWidth, after, afterWidth };
}

// node_modules/@earendil-works/pi-tui/dist/components/box.js
var Box = class {
  children = [];
  paddingX;
  paddingY;
  bgFn;
  // Cache for rendered output
  cache;
  constructor(paddingX = 1, paddingY = 1, bgFn) {
    this.paddingX = paddingX;
    this.paddingY = paddingY;
    this.bgFn = bgFn;
  }
  addChild(component) {
    this.children.push(component);
    this.invalidateCache();
  }
  removeChild(component) {
    const index = this.children.indexOf(component);
    if (index !== -1) {
      this.children.splice(index, 1);
      this.invalidateCache();
    }
  }
  clear() {
    this.children = [];
    this.invalidateCache();
  }
  setBgFn(bgFn) {
    this.bgFn = bgFn;
  }
  invalidateCache() {
    this.cache = void 0;
  }
  matchCache(width, childLines, bgSample) {
    const cache = this.cache;
    return !!cache && cache.width === width && cache.bgSample === bgSample && cache.childLines.length === childLines.length && cache.childLines.every((line, i) => line === childLines[i]);
  }
  invalidate() {
    this.invalidateCache();
    for (const child of this.children) {
      child.invalidate?.();
    }
  }
  render(width) {
    if (this.children.length === 0) {
      return [];
    }
    const contentWidth = Math.max(1, width - this.paddingX * 2);
    const leftPad = " ".repeat(this.paddingX);
    const childLines = [];
    for (const child of this.children) {
      const lines = child.render(contentWidth);
      for (const line of lines) {
        childLines.push(leftPad + line);
      }
    }
    if (childLines.length === 0) {
      return [];
    }
    const bgSample = this.bgFn ? this.bgFn("test") : void 0;
    if (this.matchCache(width, childLines, bgSample)) {
      return this.cache.lines;
    }
    const result = [];
    for (let i = 0; i < this.paddingY; i++) {
      result.push(this.applyBg("", width));
    }
    for (const line of childLines) {
      result.push(this.applyBg(line, width));
    }
    for (let i = 0; i < this.paddingY; i++) {
      result.push(this.applyBg("", width));
    }
    this.cache = { childLines, width, bgSample, lines: result };
    return result;
  }
  applyBg(line, width) {
    const visLen = visibleWidth(line);
    const padNeeded = Math.max(0, width - visLen);
    const padded = line + " ".repeat(padNeeded);
    if (this.bgFn) {
      return applyBackgroundToLine(padded, width, this.bgFn);
    }
    return padded;
  }
};

// node_modules/@earendil-works/pi-tui/dist/keys.js
var _kittyProtocolActive = false;
function setKittyProtocolActive(active) {
  _kittyProtocolActive = active;
}
var Key = {
  // Special keys
  escape: "escape",
  esc: "esc",
  enter: "enter",
  return: "return",
  tab: "tab",
  space: "space",
  backspace: "backspace",
  delete: "delete",
  insert: "insert",
  clear: "clear",
  home: "home",
  end: "end",
  pageUp: "pageUp",
  pageDown: "pageDown",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  f1: "f1",
  f2: "f2",
  f3: "f3",
  f4: "f4",
  f5: "f5",
  f6: "f6",
  f7: "f7",
  f8: "f8",
  f9: "f9",
  f10: "f10",
  f11: "f11",
  f12: "f12",
  // Symbol keys
  backtick: "`",
  hyphen: "-",
  equals: "=",
  leftbracket: "[",
  rightbracket: "]",
  backslash: "\\",
  semicolon: ";",
  quote: "'",
  comma: ",",
  period: ".",
  slash: "/",
  exclamation: "!",
  at: "@",
  hash: "#",
  dollar: "$",
  percent: "%",
  caret: "^",
  ampersand: "&",
  asterisk: "*",
  leftparen: "(",
  rightparen: ")",
  underscore: "_",
  plus: "+",
  pipe: "|",
  tilde: "~",
  leftbrace: "{",
  rightbrace: "}",
  colon: ":",
  lessthan: "<",
  greaterthan: ">",
  question: "?",
  // Single modifiers
  ctrl: (key) => `ctrl+${key}`,
  shift: (key) => `shift+${key}`,
  alt: (key) => `alt+${key}`,
  super: (key) => `super+${key}`,
  // Combined modifiers
  ctrlShift: (key) => `ctrl+shift+${key}`,
  shiftCtrl: (key) => `shift+ctrl+${key}`,
  ctrlAlt: (key) => `ctrl+alt+${key}`,
  altCtrl: (key) => `alt+ctrl+${key}`,
  shiftAlt: (key) => `shift+alt+${key}`,
  altShift: (key) => `alt+shift+${key}`,
  ctrlSuper: (key) => `ctrl+super+${key}`,
  superCtrl: (key) => `super+ctrl+${key}`,
  shiftSuper: (key) => `shift+super+${key}`,
  superShift: (key) => `super+shift+${key}`,
  altSuper: (key) => `alt+super+${key}`,
  superAlt: (key) => `super+alt+${key}`,
  // Triple modifiers
  ctrlShiftAlt: (key) => `ctrl+shift+alt+${key}`,
  ctrlShiftSuper: (key) => `ctrl+shift+super+${key}`
};
var SYMBOL_KEYS = /* @__PURE__ */ new Set([
  "`",
  "-",
  "=",
  "[",
  "]",
  "\\",
  ";",
  "'",
  ",",
  ".",
  "/",
  "!",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ")",
  "_",
  "+",
  "|",
  "~",
  "{",
  "}",
  ":",
  "<",
  ">",
  "?"
]);
var MODIFIERS = {
  shift: 1,
  alt: 2,
  ctrl: 4,
  super: 8
};
var LOCK_MASK = 64 + 128;
var CODEPOINTS = {
  escape: 27,
  tab: 9,
  enter: 13,
  space: 32,
  backspace: 127,
  kpEnter: 57414
  // Numpad Enter (Kitty protocol)
};
var ARROW_CODEPOINTS = {
  up: -1,
  down: -2,
  right: -3,
  left: -4
};
var FUNCTIONAL_CODEPOINTS = {
  delete: -10,
  insert: -11,
  pageUp: -12,
  pageDown: -13,
  home: -14,
  end: -15
};
var KITTY_FUNCTIONAL_KEY_EQUIVALENTS = /* @__PURE__ */ new Map([
  [57399, 48],
  // KP_0 -> 0
  [57400, 49],
  // KP_1 -> 1
  [57401, 50],
  // KP_2 -> 2
  [57402, 51],
  // KP_3 -> 3
  [57403, 52],
  // KP_4 -> 4
  [57404, 53],
  // KP_5 -> 5
  [57405, 54],
  // KP_6 -> 6
  [57406, 55],
  // KP_7 -> 7
  [57407, 56],
  // KP_8 -> 8
  [57408, 57],
  // KP_9 -> 9
  [57409, 46],
  // KP_DECIMAL -> .
  [57410, 47],
  // KP_DIVIDE -> /
  [57411, 42],
  // KP_MULTIPLY -> *
  [57412, 45],
  // KP_SUBTRACT -> -
  [57413, 43],
  // KP_ADD -> +
  [57415, 61],
  // KP_EQUAL -> =
  [57416, 44],
  // KP_SEPARATOR -> ,
  [57417, ARROW_CODEPOINTS.left],
  [57418, ARROW_CODEPOINTS.right],
  [57419, ARROW_CODEPOINTS.up],
  [57420, ARROW_CODEPOINTS.down],
  [57421, FUNCTIONAL_CODEPOINTS.pageUp],
  [57422, FUNCTIONAL_CODEPOINTS.pageDown],
  [57423, FUNCTIONAL_CODEPOINTS.home],
  [57424, FUNCTIONAL_CODEPOINTS.end],
  [57425, FUNCTIONAL_CODEPOINTS.insert],
  [57426, FUNCTIONAL_CODEPOINTS.delete]
]);
function normalizeKittyFunctionalCodepoint(codepoint) {
  return KITTY_FUNCTIONAL_KEY_EQUIVALENTS.get(codepoint) ?? codepoint;
}
function normalizeShiftedLetterIdentityCodepoint(codepoint, modifier) {
  const effectiveModifier = modifier & ~LOCK_MASK;
  if ((effectiveModifier & MODIFIERS.shift) !== 0 && codepoint >= 65 && codepoint <= 90) {
    return codepoint + 32;
  }
  return codepoint;
}
var LEGACY_KEY_SEQUENCES = {
  up: ["\x1B[A", "\x1BOA"],
  down: ["\x1B[B", "\x1BOB"],
  right: ["\x1B[C", "\x1BOC"],
  left: ["\x1B[D", "\x1BOD"],
  home: ["\x1B[H", "\x1BOH", "\x1B[1~", "\x1B[7~"],
  end: ["\x1B[F", "\x1BOF", "\x1B[4~", "\x1B[8~"],
  insert: ["\x1B[2~"],
  delete: ["\x1B[3~"],
  pageUp: ["\x1B[5~", "\x1B[[5~"],
  pageDown: ["\x1B[6~", "\x1B[[6~"],
  clear: ["\x1B[E", "\x1BOE"],
  f1: ["\x1BOP", "\x1B[11~", "\x1B[[A"],
  f2: ["\x1BOQ", "\x1B[12~", "\x1B[[B"],
  f3: ["\x1BOR", "\x1B[13~", "\x1B[[C"],
  f4: ["\x1BOS", "\x1B[14~", "\x1B[[D"],
  f5: ["\x1B[15~", "\x1B[[E"],
  f6: ["\x1B[17~"],
  f7: ["\x1B[18~"],
  f8: ["\x1B[19~"],
  f9: ["\x1B[20~"],
  f10: ["\x1B[21~"],
  f11: ["\x1B[23~"],
  f12: ["\x1B[24~"]
};
var LEGACY_SHIFT_SEQUENCES = {
  up: ["\x1B[a"],
  down: ["\x1B[b"],
  right: ["\x1B[c"],
  left: ["\x1B[d"],
  clear: ["\x1B[e"],
  insert: ["\x1B[2$"],
  delete: ["\x1B[3$"],
  pageUp: ["\x1B[5$"],
  pageDown: ["\x1B[6$"],
  home: ["\x1B[7$"],
  end: ["\x1B[8$"]
};
var LEGACY_CTRL_SEQUENCES = {
  up: ["\x1BOa"],
  down: ["\x1BOb"],
  right: ["\x1BOc"],
  left: ["\x1BOd"],
  clear: ["\x1BOe"],
  insert: ["\x1B[2^"],
  delete: ["\x1B[3^"],
  pageUp: ["\x1B[5^"],
  pageDown: ["\x1B[6^"],
  home: ["\x1B[7^"],
  end: ["\x1B[8^"]
};
var matchesLegacySequence = (data, sequences) => sequences.includes(data);
var matchesLegacyModifierSequence = (data, key, modifier) => {
  if (modifier === MODIFIERS.shift) {
    return matchesLegacySequence(data, LEGACY_SHIFT_SEQUENCES[key]);
  }
  if (modifier === MODIFIERS.ctrl) {
    return matchesLegacySequence(data, LEGACY_CTRL_SEQUENCES[key]);
  }
  return false;
};
var _lastEventType = "press";
function isKeyRelease(data) {
  if (data.includes("\x1B[200~")) {
    return false;
  }
  if (data.includes(":3u") || data.includes(":3~") || data.includes(":3A") || data.includes(":3B") || data.includes(":3C") || data.includes(":3D") || data.includes(":3H") || data.includes(":3F")) {
    return true;
  }
  return false;
}
function parseEventType(eventTypeStr) {
  if (!eventTypeStr)
    return "press";
  const eventType = parseInt(eventTypeStr, 10);
  if (eventType === 2)
    return "repeat";
  if (eventType === 3)
    return "release";
  return "press";
}
function parseKittySequence(data) {
  const csiUMatch = data.match(/^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/);
  if (csiUMatch) {
    const codepoint = parseInt(csiUMatch[1], 10);
    const shiftedKey = csiUMatch[2] && csiUMatch[2].length > 0 ? parseInt(csiUMatch[2], 10) : void 0;
    const baseLayoutKey = csiUMatch[3] ? parseInt(csiUMatch[3], 10) : void 0;
    const modValue = csiUMatch[4] ? parseInt(csiUMatch[4], 10) : 1;
    const eventType = parseEventType(csiUMatch[5]);
    _lastEventType = eventType;
    return { codepoint, shiftedKey, baseLayoutKey, modifier: modValue - 1, eventType };
  }
  const arrowMatch = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/);
  if (arrowMatch) {
    const modValue = parseInt(arrowMatch[1], 10);
    const eventType = parseEventType(arrowMatch[2]);
    const arrowCodes = { A: -1, B: -2, C: -3, D: -4 };
    _lastEventType = eventType;
    return { codepoint: arrowCodes[arrowMatch[3]], modifier: modValue - 1, eventType };
  }
  const funcMatch = data.match(/^\x1b\[(\d+)(?:;(\d+))?(?::(\d+))?~$/);
  if (funcMatch) {
    const keyNum = parseInt(funcMatch[1], 10);
    const modValue = funcMatch[2] ? parseInt(funcMatch[2], 10) : 1;
    const eventType = parseEventType(funcMatch[3]);
    const funcCodes = {
      2: FUNCTIONAL_CODEPOINTS.insert,
      3: FUNCTIONAL_CODEPOINTS.delete,
      5: FUNCTIONAL_CODEPOINTS.pageUp,
      6: FUNCTIONAL_CODEPOINTS.pageDown,
      7: FUNCTIONAL_CODEPOINTS.home,
      8: FUNCTIONAL_CODEPOINTS.end
    };
    const codepoint = funcCodes[keyNum];
    if (codepoint !== void 0) {
      _lastEventType = eventType;
      return { codepoint, modifier: modValue - 1, eventType };
    }
  }
  const homeEndMatch = data.match(/^\x1b\[1;(\d+)(?::(\d+))?([HF])$/);
  if (homeEndMatch) {
    const modValue = parseInt(homeEndMatch[1], 10);
    const eventType = parseEventType(homeEndMatch[2]);
    const codepoint = homeEndMatch[3] === "H" ? FUNCTIONAL_CODEPOINTS.home : FUNCTIONAL_CODEPOINTS.end;
    _lastEventType = eventType;
    return { codepoint, modifier: modValue - 1, eventType };
  }
  return null;
}
function matchesKittySequence(data, expectedCodepoint, expectedModifier) {
  const parsed = parseKittySequence(data);
  if (!parsed)
    return false;
  const actualMod = parsed.modifier & ~LOCK_MASK;
  const expectedMod = expectedModifier & ~LOCK_MASK;
  if (actualMod !== expectedMod)
    return false;
  const normalizedCodepoint = normalizeShiftedLetterIdentityCodepoint(normalizeKittyFunctionalCodepoint(parsed.codepoint), parsed.modifier);
  const normalizedExpectedCodepoint = normalizeShiftedLetterIdentityCodepoint(normalizeKittyFunctionalCodepoint(expectedCodepoint), expectedModifier);
  if (normalizedCodepoint === normalizedExpectedCodepoint)
    return true;
  if (parsed.baseLayoutKey !== void 0 && parsed.baseLayoutKey === expectedCodepoint) {
    const cp = normalizedCodepoint;
    const isLatinLetter = cp >= 97 && cp <= 122;
    const isKnownSymbol = SYMBOL_KEYS.has(String.fromCharCode(cp));
    if (!isLatinLetter && !isKnownSymbol)
      return true;
  }
  return false;
}
function parseModifyOtherKeysSequence(data) {
  const match = data.match(/^\x1b\[27;(\d+);(\d+)~$/);
  if (!match)
    return null;
  const modValue = parseInt(match[1], 10);
  const codepoint = parseInt(match[2], 10);
  return { codepoint, modifier: modValue - 1 };
}
function matchesModifyOtherKeys(data, expectedKeycode, expectedModifier) {
  const parsed = parseModifyOtherKeysSequence(data);
  if (!parsed)
    return false;
  return parsed.codepoint === expectedKeycode && parsed.modifier === expectedModifier;
}
function isWindowsTerminalSession() {
  return Boolean(process.env.WT_SESSION) && !process.env.SSH_CONNECTION && !process.env.SSH_CLIENT && !process.env.SSH_TTY;
}
function matchesRawBackspace(data, expectedModifier) {
  if (data === "\x7F")
    return expectedModifier === 0;
  if (data !== "\b")
    return false;
  return isWindowsTerminalSession() ? expectedModifier === MODIFIERS.ctrl : expectedModifier === 0;
}
function rawCtrlChar(key) {
  const char = key.toLowerCase();
  const code = char.charCodeAt(0);
  if (code >= 97 && code <= 122 || char === "[" || char === "\\" || char === "]" || char === "_") {
    return String.fromCharCode(code & 31);
  }
  if (char === "-") {
    return String.fromCharCode(31);
  }
  return null;
}
function isDigitKey(key) {
  return key >= "0" && key <= "9";
}
function matchesPrintableModifyOtherKeys(data, expectedKeycode, expectedModifier) {
  if (expectedModifier === 0)
    return false;
  const parsed = parseModifyOtherKeysSequence(data);
  if (!parsed || parsed.modifier !== expectedModifier)
    return false;
  return normalizeShiftedLetterIdentityCodepoint(parsed.codepoint, parsed.modifier) === normalizeShiftedLetterIdentityCodepoint(expectedKeycode, expectedModifier);
}
function parseKeyId(keyId) {
  const parts = keyId.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  if (!key)
    return null;
  return {
    key,
    ctrl: parts.includes("ctrl"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
    super: parts.includes("super")
  };
}
function matchesKey(data, keyId) {
  const parsed = parseKeyId(keyId);
  if (!parsed)
    return false;
  const { key, ctrl, shift, alt, super: superModifier } = parsed;
  let modifier = 0;
  if (shift)
    modifier |= MODIFIERS.shift;
  if (alt)
    modifier |= MODIFIERS.alt;
  if (ctrl)
    modifier |= MODIFIERS.ctrl;
  if (superModifier)
    modifier |= MODIFIERS.super;
  switch (key) {
    case "escape":
    case "esc":
      if (modifier !== 0)
        return false;
      return data === "\x1B" || matchesKittySequence(data, CODEPOINTS.escape, 0) || matchesModifyOtherKeys(data, CODEPOINTS.escape, 0);
    case "space":
      if (!_kittyProtocolActive) {
        if (modifier === MODIFIERS.ctrl && data === "\0") {
          return true;
        }
        if (modifier === MODIFIERS.alt && data === "\x1B ") {
          return true;
        }
      }
      if (modifier === 0) {
        return data === " " || matchesKittySequence(data, CODEPOINTS.space, 0) || matchesModifyOtherKeys(data, CODEPOINTS.space, 0);
      }
      return matchesKittySequence(data, CODEPOINTS.space, modifier) || matchesModifyOtherKeys(data, CODEPOINTS.space, modifier);
    case "tab":
      if (modifier === MODIFIERS.shift) {
        return data === "\x1B[Z" || matchesKittySequence(data, CODEPOINTS.tab, MODIFIERS.shift) || matchesModifyOtherKeys(data, CODEPOINTS.tab, MODIFIERS.shift);
      }
      if (modifier === 0) {
        return data === "	" || matchesKittySequence(data, CODEPOINTS.tab, 0);
      }
      return matchesKittySequence(data, CODEPOINTS.tab, modifier) || matchesModifyOtherKeys(data, CODEPOINTS.tab, modifier);
    case "enter":
    case "return":
      if (modifier === MODIFIERS.shift) {
        if (matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.shift) || matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.shift)) {
          return true;
        }
        if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.shift)) {
          return true;
        }
        if (_kittyProtocolActive) {
          return data === "\x1B\r" || data === "\n";
        }
        return false;
      }
      if (modifier === MODIFIERS.alt) {
        if (matchesKittySequence(data, CODEPOINTS.enter, MODIFIERS.alt) || matchesKittySequence(data, CODEPOINTS.kpEnter, MODIFIERS.alt)) {
          return true;
        }
        if (matchesModifyOtherKeys(data, CODEPOINTS.enter, MODIFIERS.alt)) {
          return true;
        }
        if (!_kittyProtocolActive) {
          return data === "\x1B\r";
        }
        return false;
      }
      if (modifier === 0) {
        return data === "\r" || !_kittyProtocolActive && data === "\n" || data === "\x1BOM" || // SS3 M (numpad enter in some terminals)
        matchesKittySequence(data, CODEPOINTS.enter, 0) || matchesKittySequence(data, CODEPOINTS.kpEnter, 0);
      }
      return matchesKittySequence(data, CODEPOINTS.enter, modifier) || matchesKittySequence(data, CODEPOINTS.kpEnter, modifier) || matchesModifyOtherKeys(data, CODEPOINTS.enter, modifier);
    case "backspace":
      if (modifier === MODIFIERS.alt) {
        if (data === "\x1B\x7F" || data === "\x1B\b") {
          return true;
        }
        return matchesKittySequence(data, CODEPOINTS.backspace, MODIFIERS.alt) || matchesModifyOtherKeys(data, CODEPOINTS.backspace, MODIFIERS.alt);
      }
      if (modifier === MODIFIERS.ctrl) {
        if (matchesRawBackspace(data, MODIFIERS.ctrl))
          return true;
        return matchesKittySequence(data, CODEPOINTS.backspace, MODIFIERS.ctrl) || matchesModifyOtherKeys(data, CODEPOINTS.backspace, MODIFIERS.ctrl);
      }
      if (modifier === 0) {
        return matchesRawBackspace(data, 0) || matchesKittySequence(data, CODEPOINTS.backspace, 0) || matchesModifyOtherKeys(data, CODEPOINTS.backspace, 0);
      }
      return matchesKittySequence(data, CODEPOINTS.backspace, modifier) || matchesModifyOtherKeys(data, CODEPOINTS.backspace, modifier);
    case "insert":
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.insert) || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.insert, 0);
      }
      if (matchesLegacyModifierSequence(data, "insert", modifier)) {
        return true;
      }
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.insert, modifier);
    case "delete":
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.delete) || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.delete, 0);
      }
      if (matchesLegacyModifierSequence(data, "delete", modifier)) {
        return true;
      }
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.delete, modifier);
    case "clear":
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.clear);
      }
      return matchesLegacyModifierSequence(data, "clear", modifier);
    case "home":
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.home) || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.home, 0);
      }
      if (matchesLegacyModifierSequence(data, "home", modifier)) {
        return true;
      }
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.home, modifier);
    case "end":
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.end) || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.end, 0);
      }
      if (matchesLegacyModifierSequence(data, "end", modifier)) {
        return true;
      }
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.end, modifier);
    case "pageup":
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.pageUp) || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageUp, 0);
      }
      if (matchesLegacyModifierSequence(data, "pageUp", modifier)) {
        return true;
      }
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageUp, modifier);
    case "pagedown":
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.pageDown) || matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageDown, 0);
      }
      if (matchesLegacyModifierSequence(data, "pageDown", modifier)) {
        return true;
      }
      return matchesKittySequence(data, FUNCTIONAL_CODEPOINTS.pageDown, modifier);
    case "up":
      if (modifier === MODIFIERS.alt) {
        return data === "\x1Bp" || matchesKittySequence(data, ARROW_CODEPOINTS.up, MODIFIERS.alt);
      }
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.up) || matchesKittySequence(data, ARROW_CODEPOINTS.up, 0);
      }
      if (matchesLegacyModifierSequence(data, "up", modifier)) {
        return true;
      }
      return matchesKittySequence(data, ARROW_CODEPOINTS.up, modifier);
    case "down":
      if (modifier === MODIFIERS.alt) {
        return data === "\x1Bn" || matchesKittySequence(data, ARROW_CODEPOINTS.down, MODIFIERS.alt);
      }
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.down) || matchesKittySequence(data, ARROW_CODEPOINTS.down, 0);
      }
      if (matchesLegacyModifierSequence(data, "down", modifier)) {
        return true;
      }
      return matchesKittySequence(data, ARROW_CODEPOINTS.down, modifier);
    case "left":
      if (modifier === MODIFIERS.alt) {
        return data === "\x1B[1;3D" || !_kittyProtocolActive && data === "\x1BB" || data === "\x1Bb" || matchesKittySequence(data, ARROW_CODEPOINTS.left, MODIFIERS.alt);
      }
      if (modifier === MODIFIERS.ctrl) {
        return data === "\x1B[1;5D" || matchesLegacyModifierSequence(data, "left", MODIFIERS.ctrl) || matchesKittySequence(data, ARROW_CODEPOINTS.left, MODIFIERS.ctrl);
      }
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.left) || matchesKittySequence(data, ARROW_CODEPOINTS.left, 0);
      }
      if (matchesLegacyModifierSequence(data, "left", modifier)) {
        return true;
      }
      return matchesKittySequence(data, ARROW_CODEPOINTS.left, modifier);
    case "right":
      if (modifier === MODIFIERS.alt) {
        return data === "\x1B[1;3C" || !_kittyProtocolActive && data === "\x1BF" || data === "\x1Bf" || matchesKittySequence(data, ARROW_CODEPOINTS.right, MODIFIERS.alt);
      }
      if (modifier === MODIFIERS.ctrl) {
        return data === "\x1B[1;5C" || matchesLegacyModifierSequence(data, "right", MODIFIERS.ctrl) || matchesKittySequence(data, ARROW_CODEPOINTS.right, MODIFIERS.ctrl);
      }
      if (modifier === 0) {
        return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES.right) || matchesKittySequence(data, ARROW_CODEPOINTS.right, 0);
      }
      if (matchesLegacyModifierSequence(data, "right", modifier)) {
        return true;
      }
      return matchesKittySequence(data, ARROW_CODEPOINTS.right, modifier);
    case "f1":
    case "f2":
    case "f3":
    case "f4":
    case "f5":
    case "f6":
    case "f7":
    case "f8":
    case "f9":
    case "f10":
    case "f11":
    case "f12": {
      if (modifier !== 0) {
        return false;
      }
      const functionKey = key;
      return matchesLegacySequence(data, LEGACY_KEY_SEQUENCES[functionKey]);
    }
  }
  if (key.length === 1 && (key >= "a" && key <= "z" || isDigitKey(key) || SYMBOL_KEYS.has(key))) {
    const codepoint = key.charCodeAt(0);
    const rawCtrl = rawCtrlChar(key);
    const isLetter = key >= "a" && key <= "z";
    const isDigit = isDigitKey(key);
    if (modifier === MODIFIERS.ctrl + MODIFIERS.alt && !_kittyProtocolActive && rawCtrl) {
      if (data === `\x1B${rawCtrl}`)
        return true;
    }
    if (modifier === MODIFIERS.alt && !_kittyProtocolActive && (isLetter || isDigit || SYMBOL_KEYS.has(key))) {
      if (data === `\x1B${key}`)
        return true;
    }
    if (modifier === MODIFIERS.ctrl) {
      if (rawCtrl && data === rawCtrl)
        return true;
      return matchesKittySequence(data, codepoint, MODIFIERS.ctrl) || matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.ctrl);
    }
    if (modifier === MODIFIERS.shift + MODIFIERS.ctrl) {
      return matchesKittySequence(data, codepoint, MODIFIERS.shift + MODIFIERS.ctrl) || matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.shift + MODIFIERS.ctrl);
    }
    if (modifier === MODIFIERS.shift) {
      if (isLetter && data === key.toUpperCase())
        return true;
      return matchesKittySequence(data, codepoint, MODIFIERS.shift) || matchesPrintableModifyOtherKeys(data, codepoint, MODIFIERS.shift);
    }
    if (modifier !== 0) {
      return matchesKittySequence(data, codepoint, modifier) || matchesPrintableModifyOtherKeys(data, codepoint, modifier);
    }
    return data === key || matchesKittySequence(data, codepoint, 0);
  }
  return false;
}
var KITTY_CSI_U_REGEX = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/;
var KITTY_PRINTABLE_ALLOWED_MODIFIERS = MODIFIERS.shift | LOCK_MASK;
function decodeKittyPrintable(data) {
  const match = data.match(KITTY_CSI_U_REGEX);
  if (!match)
    return void 0;
  const codepoint = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(codepoint))
    return void 0;
  const shiftedKey = match[2] && match[2].length > 0 ? Number.parseInt(match[2], 10) : void 0;
  const modValue = match[4] ? Number.parseInt(match[4], 10) : 1;
  const modifier = Number.isFinite(modValue) ? modValue - 1 : 0;
  if ((modifier & ~KITTY_PRINTABLE_ALLOWED_MODIFIERS) !== 0)
    return void 0;
  if (modifier & (MODIFIERS.alt | MODIFIERS.ctrl))
    return void 0;
  let effectiveCodepoint = codepoint;
  if (modifier & MODIFIERS.shift && typeof shiftedKey === "number") {
    effectiveCodepoint = shiftedKey;
  }
  effectiveCodepoint = normalizeKittyFunctionalCodepoint(effectiveCodepoint);
  if (!Number.isFinite(effectiveCodepoint) || effectiveCodepoint < 32)
    return void 0;
  try {
    return String.fromCodePoint(effectiveCodepoint);
  } catch {
    return void 0;
  }
}

// node_modules/@earendil-works/pi-tui/dist/keybindings.js
var TUI_KEYBINDINGS = {
  "tui.editor.cursorUp": { defaultKeys: "up", description: "Move cursor up" },
  "tui.editor.cursorDown": { defaultKeys: "down", description: "Move cursor down" },
  "tui.editor.historyPrevious": {
    defaultKeys: [],
    description: "Select previous prompt history entry"
  },
  "tui.editor.historyNext": {
    defaultKeys: [],
    description: "Select next prompt history entry"
  },
  "tui.editor.cursorLeft": {
    defaultKeys: ["left", "ctrl+b"],
    description: "Move cursor left"
  },
  "tui.editor.cursorRight": {
    defaultKeys: ["right", "ctrl+f"],
    description: "Move cursor right"
  },
  "tui.editor.cursorWordLeft": {
    defaultKeys: ["alt+left", "ctrl+left", "alt+b"],
    description: "Move cursor word left"
  },
  "tui.editor.cursorWordRight": {
    defaultKeys: ["alt+right", "ctrl+right", "alt+f"],
    description: "Move cursor word right"
  },
  "tui.editor.cursorLineStart": {
    defaultKeys: ["home", "ctrl+home", "ctrl+a"],
    description: "Move to line start"
  },
  "tui.editor.cursorLineEnd": {
    defaultKeys: ["end", "ctrl+end", "ctrl+e"],
    description: "Move to line end"
  },
  "tui.editor.jumpForward": {
    defaultKeys: "ctrl+]",
    description: "Jump forward to character"
  },
  "tui.editor.jumpBackward": {
    defaultKeys: "ctrl+alt+]",
    description: "Jump backward to character"
  },
  "tui.editor.pageUp": { defaultKeys: ["pageUp", "ctrl+pageUp"], description: "Page up" },
  "tui.editor.pageDown": { defaultKeys: ["pageDown", "ctrl+pageDown"], description: "Page down" },
  "tui.editor.deleteCharBackward": {
    defaultKeys: "backspace",
    description: "Delete character backward"
  },
  "tui.editor.deleteCharForward": {
    defaultKeys: ["delete", "ctrl+d"],
    description: "Delete character forward"
  },
  "tui.editor.deleteWordBackward": {
    defaultKeys: ["ctrl+w", "alt+backspace"],
    description: "Delete word backward"
  },
  "tui.editor.deleteWordForward": {
    defaultKeys: ["alt+d", "alt+delete"],
    description: "Delete word forward"
  },
  "tui.editor.deleteToLineStart": {
    defaultKeys: "ctrl+u",
    description: "Delete to line start"
  },
  "tui.editor.deleteToLineEnd": {
    defaultKeys: "ctrl+k",
    description: "Delete to line end"
  },
  "tui.editor.yank": { defaultKeys: "ctrl+y", description: "Yank" },
  "tui.editor.yankPop": { defaultKeys: "alt+y", description: "Yank pop" },
  "tui.editor.undo": { defaultKeys: "ctrl+-", description: "Undo" },
  "tui.input.newLine": { defaultKeys: ["shift+enter", "ctrl+j"], description: "Insert newline" },
  "tui.input.submit": { defaultKeys: "enter", description: "Submit input" },
  "tui.input.tab": { defaultKeys: "tab", description: "Tab / autocomplete" },
  "tui.input.copy": { defaultKeys: "ctrl+c", description: "Copy selection" },
  "tui.select.up": { defaultKeys: "up", description: "Move selection up" },
  "tui.select.down": { defaultKeys: "down", description: "Move selection down" },
  "tui.select.pageUp": { defaultKeys: "pageUp", description: "Selection page up" },
  "tui.select.pageDown": {
    defaultKeys: "pageDown",
    description: "Selection page down"
  },
  "tui.select.confirm": { defaultKeys: "enter", description: "Confirm selection" },
  "tui.select.cancel": {
    defaultKeys: ["escape", "ctrl+c"],
    description: "Cancel selection"
  },
  // These intentionally shadow the unmodified editor bindings in fullscreen mode.
  "tui.altScreen.pageUp": {
    defaultKeys: "pageUp",
    description: "Scroll viewport up one page"
  },
  "tui.altScreen.pageDown": {
    defaultKeys: "pageDown",
    description: "Scroll viewport down one page"
  },
  "tui.altScreen.halfPageUp": {
    defaultKeys: [],
    description: "Scroll viewport up half a page"
  },
  "tui.altScreen.halfPageDown": {
    defaultKeys: [],
    description: "Scroll viewport down half a page"
  },
  "tui.altScreen.lineUp": {
    defaultKeys: [],
    description: "Scroll viewport up one line"
  },
  "tui.altScreen.lineDown": {
    defaultKeys: [],
    description: "Scroll viewport down one line"
  },
  "tui.altScreen.previousPrompt": {
    defaultKeys: ["ctrl+shift+up", "ctrl+up"],
    description: "Jump to previous semantic prompt"
  },
  "tui.altScreen.nextPrompt": {
    defaultKeys: ["ctrl+shift+down", "ctrl+down"],
    description: "Jump to next semantic prompt"
  },
  "tui.altScreen.search": {
    defaultKeys: "ctrl+shift+f",
    description: "Search the primary scroll view"
  },
  "tui.altScreen.searchNext": {
    defaultKeys: ["enter", "ctrl+g"],
    description: "Select the next search match"
  },
  "tui.altScreen.searchPrevious": {
    defaultKeys: ["shift+enter", "ctrl+shift+g"],
    description: "Select the previous search match"
  },
  "tui.altScreen.searchClose": {
    defaultKeys: "escape",
    description: "Close transcript search"
  },
  "tui.altScreen.top": { defaultKeys: "home", description: "Scroll viewport to top" },
  "tui.altScreen.bottom": { defaultKeys: "end", description: "Scroll viewport to bottom" }
};
function normalizeKeys(keys) {
  if (keys === void 0)
    return [];
  const keyList = Array.isArray(keys) ? keys : [keys];
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const key of keyList) {
    if (!seen.has(key)) {
      seen.add(key);
      result.push(key);
    }
  }
  return result;
}
var KeybindingsManager = class {
  definitions;
  userBindings;
  keysById = /* @__PURE__ */ new Map();
  conflicts = [];
  constructor(definitions, userBindings = {}) {
    this.definitions = definitions;
    this.userBindings = userBindings;
    this.rebuild();
  }
  rebuild() {
    this.keysById.clear();
    this.conflicts = [];
    const userClaims = /* @__PURE__ */ new Map();
    for (const [keybinding, keys] of Object.entries(this.userBindings)) {
      if (!(keybinding in this.definitions))
        continue;
      for (const key of normalizeKeys(keys)) {
        const claimants = userClaims.get(key) ?? /* @__PURE__ */ new Set();
        claimants.add(keybinding);
        userClaims.set(key, claimants);
      }
    }
    for (const [key, keybindings] of userClaims) {
      if (keybindings.size > 1) {
        this.conflicts.push({ key, keybindings: [...keybindings] });
      }
    }
    for (const [id, definition] of Object.entries(this.definitions)) {
      const userKeys = this.userBindings[id];
      const keys = userKeys === void 0 ? normalizeKeys(definition.defaultKeys) : normalizeKeys(userKeys);
      this.keysById.set(id, keys);
    }
  }
  matches(data, keybinding) {
    const keys = this.keysById.get(keybinding) ?? [];
    for (const key of keys) {
      if (matchesKey(data, key))
        return true;
    }
    return false;
  }
  getKeys(keybinding) {
    return [...this.keysById.get(keybinding) ?? []];
  }
  getDefinition(keybinding) {
    return this.definitions[keybinding];
  }
  getConflicts() {
    return this.conflicts.map((conflict) => ({ ...conflict, keybindings: [...conflict.keybindings] }));
  }
  setUserBindings(userBindings) {
    this.userBindings = userBindings;
    this.rebuild();
  }
  getUserBindings() {
    return { ...this.userBindings };
  }
  getResolvedBindings() {
    const resolved = {};
    for (const id of Object.keys(this.definitions)) {
      const keys = this.keysById.get(id) ?? [];
      resolved[id] = keys.length === 1 ? keys[0] : [...keys];
    }
    return resolved;
  }
};
var globalKeybindings = null;
function getKeybindings() {
  if (!globalKeybindings) {
    globalKeybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  }
  return globalKeybindings;
}

// node_modules/@earendil-works/pi-tui/dist/components/text.js
var Text = class {
  text;
  paddingX;
  // Left/right padding
  paddingY;
  // Top/bottom padding
  customBgFn;
  // Cache for rendered output
  cachedText;
  cachedWidth;
  cachedLines;
  constructor(text = "", paddingX = 1, paddingY = 1, customBgFn) {
    this.text = text;
    this.paddingX = paddingX;
    this.paddingY = paddingY;
    this.customBgFn = customBgFn;
  }
  setText(text) {
    this.text = text;
    this.cachedText = void 0;
    this.cachedWidth = void 0;
    this.cachedLines = void 0;
  }
  setCustomBgFn(customBgFn) {
    this.customBgFn = customBgFn;
    this.cachedText = void 0;
    this.cachedWidth = void 0;
    this.cachedLines = void 0;
  }
  invalidate() {
    this.cachedText = void 0;
    this.cachedWidth = void 0;
    this.cachedLines = void 0;
  }
  render(width) {
    if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
      return this.cachedLines;
    }
    if (!this.text || this.text.trim() === "") {
      const result2 = [];
      this.cachedText = this.text;
      this.cachedWidth = width;
      this.cachedLines = result2;
      return result2;
    }
    const normalizedText = this.text.replace(/\t/g, "   ");
    const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
    const contentWidth = Math.max(1, width - paddingX * 2);
    const wrappedLines = wrapTextWithAnsi(normalizedText, contentWidth);
    const leftMargin = " ".repeat(paddingX);
    const rightMargin = " ".repeat(paddingX);
    const contentLines = [];
    for (const line of wrappedLines) {
      const lineWithMargins = leftMargin + line + rightMargin;
      if (this.customBgFn) {
        contentLines.push(applyBackgroundToLine(lineWithMargins, width, this.customBgFn));
      } else {
        const visibleLen = visibleWidth(lineWithMargins);
        const paddingNeeded = Math.max(0, width - visibleLen);
        contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
      }
    }
    const emptyLine = " ".repeat(width);
    const emptyLines = [];
    for (let i = 0; i < this.paddingY; i++) {
      const line = this.customBgFn ? applyBackgroundToLine(emptyLine, width, this.customBgFn) : emptyLine;
      emptyLines.push(line);
    }
    const result = [...emptyLines, ...contentLines, ...emptyLines];
    this.cachedText = this.text;
    this.cachedWidth = width;
    this.cachedLines = result;
    return result.length > 0 ? result : [""];
  }
};

// node_modules/@earendil-works/pi-tui/dist/kill-ring.js
var KillRing = class {
  ring = [];
  /**
   * Add text to the kill ring.
   *
   * @param text - The killed text to add
   * @param opts - Push options
   * @param opts.prepend - If accumulating, prepend (backward deletion) or append (forward deletion)
   * @param opts.accumulate - Merge with the most recent entry instead of creating a new one
   */
  push(text, opts) {
    if (!text)
      return;
    if (opts.accumulate && this.ring.length > 0) {
      const last = this.ring.pop();
      this.ring.push(opts.prepend ? text + last : last + text);
    } else {
      this.ring.push(text);
    }
  }
  /** Get most recent entry without modifying the ring. */
  peek() {
    return this.ring.length > 0 ? this.ring[this.ring.length - 1] : void 0;
  }
  /** Move last entry to front (for yank-pop cycling). */
  rotate() {
    if (this.ring.length > 1) {
      const last = this.ring.pop();
      this.ring.unshift(last);
    }
  }
  get length() {
    return this.ring.length;
  }
};

// node_modules/@earendil-works/pi-tui/dist/tui.js
import * as os from "node:os";
import * as path2 from "node:path";
import { performance } from "node:perf_hooks";

// node_modules/@earendil-works/pi-tui/dist/terminal-colors.js
function hexToRgb(hex) {
  const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
  const r = parseInt(normalized.slice(0, 2), 16);
  const g2 = parseInt(normalized.slice(2, 4), 16);
  const b2 = parseInt(normalized.slice(4, 6), 16);
  return { r, g: g2, b: b2 };
}
function parseOscHexChannel(channel) {
  if (!/^[0-9a-f]+$/i.test(channel)) {
    return void 0;
  }
  const max = 16 ** channel.length - 1;
  if (max <= 0) {
    return void 0;
  }
  return Math.round(parseInt(channel, 16) / max * 255);
}
var OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN = /^\x1b\]11;([^\x07\x1b]*)(?:\x07|\x1b\\)$/i;
var COLOR_SCHEME_REPORT_PATTERN = /^(?:\x1b\[\?997;(1|2)n)+$/;
function isOsc11BackgroundColorResponse(data) {
  return OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN.test(data);
}
function parseOsc11BackgroundColor(data) {
  const match = data.match(OSC11_BACKGROUND_COLOR_RESPONSE_PATTERN);
  if (!match) {
    return void 0;
  }
  const value = match[1].trim();
  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      return hexToRgb(value);
    }
    if (/^[0-9a-f]{12}$/i.test(hex)) {
      const r2 = parseOscHexChannel(hex.slice(0, 4));
      const g3 = parseOscHexChannel(hex.slice(4, 8));
      const b3 = parseOscHexChannel(hex.slice(8, 12));
      return r2 !== void 0 && g3 !== void 0 && b3 !== void 0 ? { r: r2, g: g3, b: b3 } : void 0;
    }
    return void 0;
  }
  const rgbValue = value.replace(/^rgba?:/i, "");
  const [red, green, blue] = rgbValue.split("/");
  if (red === void 0 || green === void 0 || blue === void 0) {
    return void 0;
  }
  const r = parseOscHexChannel(red);
  const g2 = parseOscHexChannel(green);
  const b2 = parseOscHexChannel(blue);
  return r !== void 0 && g2 !== void 0 && b2 !== void 0 ? { r, g: g2, b: b2 } : void 0;
}
function parseTerminalColorSchemeReport(data) {
  const match = data.match(COLOR_SCHEME_REPORT_PATTERN);
  if (!match) {
    return void 0;
  }
  return match[1] === "2" ? "light" : "dark";
}

// node_modules/@earendil-works/pi-tui/dist/terminal-image.js
import { execSync } from "node:child_process";
var cachedCapabilities = null;
var cellDimensions = { widthPx: 9, heightPx: 18 };
function setCellDimensions(dims) {
  cellDimensions = dims;
}
function probeTmuxHyperlinks() {
  try {
    const termfeatures = execSync("tmux display-message -p '#{client_termfeatures}'", {
      encoding: "utf8",
      timeout: 250,
      stdio: ["ignore", "pipe", "ignore"]
    });
    return termfeatures.split(",").map((feature) => feature.trim()).includes("hyperlinks");
  } catch {
    return false;
  }
}
function detectCapabilities(tmuxForwardsHyperlink = probeTmuxHyperlinks) {
  const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || "";
  const terminalEmulator = process.env.TERMINAL_EMULATOR?.toLowerCase() || "";
  const term = process.env.TERM?.toLowerCase() || "";
  const colorTerm = process.env.COLORTERM?.toLowerCase() || "";
  const hasTrueColorHint = colorTerm === "truecolor" || colorTerm === "24bit";
  const isWindowsConsole = process.platform === "win32";
  if (process.env.TMUX || term.startsWith("tmux")) {
    return { images: null, trueColor: hasTrueColorHint, hyperlinks: tmuxForwardsHyperlink() };
  }
  if (term.startsWith("screen")) {
    return { images: null, trueColor: hasTrueColorHint, hyperlinks: false };
  }
  if (process.env.KITTY_WINDOW_ID || termProgram === "kitty") {
    return { images: "kitty", trueColor: true, hyperlinks: true };
  }
  if (termProgram === "ghostty" || term.includes("ghostty") || process.env.GHOSTTY_RESOURCES_DIR) {
    return { images: "kitty", trueColor: true, hyperlinks: true };
  }
  if (process.env.WEZTERM_PANE || termProgram === "wezterm") {
    return { images: "kitty", trueColor: true, hyperlinks: true };
  }
  if (termProgram === "warpterminal" || process.env.WARP_SESSION_ID || process.env.WARP_TERMINAL_SESSION_UUID) {
    return { images: "kitty", trueColor: true, hyperlinks: true };
  }
  if (process.env.ITERM_SESSION_ID || termProgram === "iterm.app") {
    return { images: "iterm2", trueColor: true, hyperlinks: true };
  }
  if (process.env.WT_SESSION) {
    return { images: null, trueColor: true, hyperlinks: true };
  }
  if (termProgram === "vscode") {
    return { images: null, trueColor: true, hyperlinks: true };
  }
  if (termProgram === "alacritty") {
    return { images: null, trueColor: true, hyperlinks: true };
  }
  if (terminalEmulator === "jetbrains-jediterm") {
    return { images: null, trueColor: true, hyperlinks: false };
  }
  if (isWindowsConsole) {
    return { images: null, trueColor: true, hyperlinks: false };
  }
  return { images: null, trueColor: hasTrueColorHint, hyperlinks: false };
}
function getCapabilities() {
  if (!cachedCapabilities) {
    cachedCapabilities = detectCapabilities();
  }
  return cachedCapabilities;
}
function setCapabilities(caps) {
  cachedCapabilities = caps;
}
var KITTY_PREFIX = "\x1B_G";
var ITERM2_PREFIX = "\x1B]1337;File=";
function isImageLine(line) {
  if (line.startsWith(KITTY_PREFIX) || line.startsWith(ITERM2_PREFIX)) {
    return true;
  }
  return line.includes(KITTY_PREFIX) || line.includes(ITERM2_PREFIX);
}
function deleteKittyImage(imageId) {
  return `\x1B_Ga=d,d=I,i=${imageId},q=2\x1B\\`;
}
function deleteAllKittyImages() {
  return "\x1B_Ga=d,d=A,q=2\x1B\\";
}
function deleteAllKittyPlacements() {
  return "\x1B_Ga=d,d=a,q=2\x1B\\";
}
var kittyImageMetadata = /* @__PURE__ */ new Map();
function getRegisteredKittyImageMetadata(line) {
  const controls = /\x1b_G([^;]*);/.exec(line)?.[1];
  if (!controls)
    return void 0;
  const imageId = /(?:^|,)i=(\d+)(?:,|$)/.exec(controls)?.[1];
  return imageId === void 0 ? void 0 : kittyImageMetadata.get(Number.parseInt(imageId, 10));
}
function getKittyImageMetadata(line) {
  const metadata = getRegisteredKittyImageMetadata(line);
  if (!metadata)
    return void 0;
  return {
    imageId: metadata.imageId,
    columns: metadata.columns,
    rows: metadata.rows,
    widthPx: metadata.widthPx,
    heightPx: metadata.heightPx
  };
}
var KITTY_PLACEMENT_CONTROL_KEYS = /* @__PURE__ */ new Set([
  "i",
  "p",
  "x",
  "y",
  "w",
  "h",
  "X",
  "Y",
  "c",
  "r",
  "C",
  "U",
  "z",
  "P",
  "Q",
  "H",
  "V"
]);
function getKittyImagePlacement(line) {
  const match = /\x1b_G([^;]*);/.exec(line);
  const metadata = getRegisteredKittyImageMetadata(line);
  if (!match || !metadata)
    return void 0;
  let commandStart = match.index;
  let commandControls = match[1];
  let transmissionEnd;
  while (true) {
    const terminator = line.indexOf("\x1B\\", commandStart + KITTY_PREFIX.length);
    if (terminator === -1)
      return void 0;
    transmissionEnd = terminator + 2;
    if (!/(?:^|,)m=1(?:,|$)/.test(commandControls))
      break;
    commandStart = transmissionEnd;
    if (!line.startsWith(KITTY_PREFIX, commandStart))
      return void 0;
    const controlsEnd = line.indexOf(";", commandStart + KITTY_PREFIX.length);
    if (controlsEnd === -1)
      return void 0;
    commandControls = line.slice(commandStart + KITTY_PREFIX.length, controlsEnd);
  }
  const controls = match[1].split(",").filter((control) => KITTY_PLACEMENT_CONTROL_KEYS.has(control.split("=", 1)[0] ?? ""));
  const sequence = `\x1B_Ga=p,q=2,${controls.join(",")}\x1B\\`;
  return {
    imageId: metadata.imageId,
    transmissionGeneration: metadata.transmissionGeneration,
    transmissionBytes: transmissionEnd - match.index,
    estimatedDecodedBytes: metadata.widthPx * metadata.heightPx * 4,
    sequence,
    replacementLine: `${line.slice(0, match.index)}${sequence}${line.slice(transmissionEnd)}`
  };
}
function cropKittyImageLine(line, hiddenRows, visibleRows) {
  const metadata = getKittyImageMetadata(line);
  const match = /\x1b_G([^;]*);/.exec(line);
  if (!metadata || !match || hiddenRows < 0 || hiddenRows >= metadata.rows || visibleRows <= 0)
    return line;
  const croppedRows = Math.min(visibleRows, metadata.rows - hiddenRows);
  if (hiddenRows === 0 && croppedRows === metadata.rows)
    return line;
  const sourceY = Math.floor(metadata.heightPx * hiddenRows / metadata.rows);
  const sourceEnd = Math.ceil(metadata.heightPx * (hiddenRows + croppedRows) / metadata.rows);
  const sourceHeight = Math.max(1, Math.min(metadata.heightPx, sourceEnd) - sourceY);
  const controls = match[1].split(",").filter((control) => !/^[yhr]=/.test(control));
  controls.push(`y=${sourceY}`, `h=${sourceHeight}`, `r=${croppedRows}`);
  return `${line.slice(0, match.index)}\x1B_G${controls.join(",")};${line.slice(match.index + match[0].length)}`;
}

// node_modules/@earendil-works/pi-tui/dist/tui.js
function isFocusable(component) {
  return component !== null && "focused" in component;
}
var CURSOR_MARKER = "\x1B_pi:c\x07";
function parseSizeValue(value, referenceSize) {
  if (value === void 0)
    return void 0;
  if (typeof value === "number")
    return value;
  const match = value.match(/^(\d+(?:\.\d+)?)%$/);
  if (match) {
    return Math.floor(referenceSize * parseFloat(match[1]) / 100);
  }
  return void 0;
}
var Container = class {
  children = [];
  addChild(component) {
    this.children.push(component);
  }
  removeChild(component) {
    const index = this.children.indexOf(component);
    if (index !== -1) {
      this.children.splice(index, 1);
    }
  }
  clear() {
    this.children = [];
  }
  invalidate() {
    for (const child of this.children) {
      child.invalidate?.();
    }
  }
  render(width) {
    const lines = [];
    for (const child of this.children) {
      const childLines = child.render(width);
      for (const line of childLines) {
        lines.push(line);
      }
    }
    return lines;
  }
};
var SEGMENT_RESET = "\x1B[0m\x1B]8;;\x07";
function compositeTuiLine(baseLine, overlayLine, startCol, overlayWidth, totalWidth) {
  if (isImageLine(baseLine))
    return baseLine;
  const afterStart = startCol + overlayWidth;
  const base = extractSegments(baseLine, startCol, afterStart, totalWidth - afterStart, true);
  const overlay = sliceWithWidth(overlayLine, 0, overlayWidth, true);
  const beforePad = Math.max(0, startCol - base.beforeWidth);
  const overlayPad = Math.max(0, overlayWidth - overlay.width);
  const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
  const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
  const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
  const afterPad = Math.max(0, afterTarget - base.afterWidth);
  const result = base.before + " ".repeat(beforePad) + SEGMENT_RESET + overlay.text + " ".repeat(overlayPad) + SEGMENT_RESET + base.after + " ".repeat(afterPad);
  return visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true);
}
var VIEWPORT_TUI = /* @__PURE__ */ Symbol.for("@earendil-works/pi-tui/viewport");
var TuiBase = class _TuiBase extends Container {
  terminal;
  focusedComponent = null;
  inputListeners = /* @__PURE__ */ new Set();
  /** Global callback for debug key (Shift+Ctrl+D). Called before input is forwarded to focused component. */
  onDebug;
  renderRequested = false;
  immediateRenderScheduled = false;
  renderTimer;
  lastRenderAt = 0;
  static MIN_RENDER_INTERVAL_MS = 16;
  showHardwareCursor = process.env.PI_HARDWARE_CURSOR === "1";
  clearOnShrink = process.env.PI_CLEAR_ON_SHRINK === "1";
  fullRedrawCount = 0;
  stopped = false;
  pendingOsc11BackgroundReplies = 0;
  pendingOsc11BackgroundQueries = [];
  terminalColorSchemeListeners = /* @__PURE__ */ new Set();
  terminalColorSchemeNotificationsEnabled = false;
  logDirectory;
  // Overlay stack for modal components rendered on top of base content
  focusOrderCounter = 0;
  overlayStack = [];
  get hasOverlayEntries() {
    return this.overlayStack.length > 0;
  }
  overlayFocusRestore = { status: "inactive" };
  constructor(terminal, showHardwareCursor, logDirectory) {
    super();
    this.terminal = terminal;
    this.logDirectory = logDirectory ?? process.env.PI_CODING_AGENT_DIR ?? path2.join(os.homedir(), ".pi", "agent");
    if (showHardwareCursor !== void 0) {
      this.showHardwareCursor = showHardwareCursor;
    }
  }
  resetRenderState() {
  }
  beforeTerminalStart() {
  }
  afterTerminalStart() {
  }
  beforeTerminalStop(_options) {
  }
  afterTerminalStop(_options) {
  }
  get fullRedraws() {
    return this.fullRedrawCount;
  }
  getShowHardwareCursor() {
    return this.showHardwareCursor;
  }
  setShowHardwareCursor(enabled) {
    if (this.showHardwareCursor === enabled)
      return;
    this.showHardwareCursor = enabled;
    if (!enabled) {
      this.terminal.hideCursor();
    }
    this.requestRender();
  }
  getClearOnShrink() {
    return this.clearOnShrink;
  }
  /**
   * Set whether to trigger full re-render when content shrinks.
   * When true (default), empty rows are cleared when content shrinks.
   * When false, empty rows remain (reduces redraws on slower terminals).
   */
  setClearOnShrink(enabled) {
    this.clearOnShrink = enabled;
  }
  getFocusedComponent() {
    return this.focusedComponent;
  }
  setFocus(component) {
    this.setFocusInternal({ component, overlayFocusRestore: "clear" });
  }
  setFocusInternal({ component, overlayFocusRestore }) {
    const previousFocus = this.focusedComponent;
    let nextFocus = component;
    const previousFocusedOverlay = previousFocus ? this.overlayStack.find((entry) => entry.component === previousFocus && this.isOverlayVisible(entry)) : void 0;
    const nextFocusIsOverlay = nextFocus ? this.overlayStack.some((entry) => entry.component === nextFocus) : false;
    const restoreState = this.getVisibleOverlayFocusRestore();
    if (nextFocus && !nextFocusIsOverlay) {
      if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
        if (restoreState.resume.status === "focus-target" || !this.isComponentMounted(restoreState.blockedBy)) {
          nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
        } else {
          this.overlayFocusRestore = {
            status: "blocked",
            overlay: restoreState.overlay,
            blockedBy: nextFocus,
            resume: restoreState.resume
          };
        }
      } else if (previousFocusedOverlay && restoreState.status !== "inactive" && restoreState.overlay === previousFocusedOverlay && !this.isOverlayFocusAncestor(previousFocusedOverlay, nextFocus)) {
        this.overlayFocusRestore = {
          status: "blocked",
          overlay: previousFocusedOverlay,
          blockedBy: nextFocus,
          resume: { status: "restore-overlay" }
        };
      }
    } else if (nextFocus === null) {
      if (restoreState.status === "blocked" && restoreState.blockedBy === previousFocus) {
        nextFocus = this.resolveBlockedOverlayFocusResume(restoreState);
      } else if (overlayFocusRestore === "clear") {
        this.clearOverlayFocusRestore();
      }
    }
    if (isFocusable(this.focusedComponent)) {
      this.focusedComponent.focused = false;
    }
    this.focusedComponent = nextFocus;
    if (isFocusable(nextFocus)) {
      nextFocus.focused = true;
    }
    const focusedOverlay = nextFocus ? this.overlayStack.find((entry) => entry.component === nextFocus && this.isOverlayVisible(entry)) : void 0;
    if (focusedOverlay) {
      this.overlayFocusRestore = { status: "eligible", overlay: focusedOverlay };
    }
  }
  clearOverlayFocusRestore() {
    this.overlayFocusRestore = { status: "inactive" };
  }
  clearOverlayFocusRestoreFor(overlay) {
    if (this.overlayFocusRestore.status !== "inactive" && this.overlayFocusRestore.overlay === overlay) {
      this.clearOverlayFocusRestore();
    }
  }
  resolveBlockedOverlayFocusResume(restoreState) {
    if (restoreState.resume.status === "restore-overlay")
      return restoreState.overlay.component;
    this.clearOverlayFocusRestore();
    return restoreState.resume.target;
  }
  getVisibleOverlayFocusRestore() {
    const restoreState = this.overlayFocusRestore;
    if (restoreState.status === "inactive")
      return restoreState;
    if (!this.overlayStack.includes(restoreState.overlay) || !this.isOverlayVisible(restoreState.overlay)) {
      return { status: "inactive" };
    }
    return restoreState;
  }
  isOverlayFocusAncestor(entry, component) {
    const visited = /* @__PURE__ */ new Set();
    let current = entry.preFocus;
    while (current && !visited.has(current)) {
      visited.add(current);
      if (current === component)
        return true;
      current = this.overlayStack.find((overlay) => overlay.component === current)?.preFocus ?? null;
    }
    return false;
  }
  retargetOverlayPreFocus(removed) {
    for (const overlay of this.overlayStack) {
      if (overlay !== removed && overlay.preFocus === removed.component) {
        overlay.preFocus = removed.preFocus;
      }
    }
  }
  getMountedRoots() {
    return this.children;
  }
  isComponentMounted(component) {
    return this.getMountedRoots().some((child) => this.containsComponent(child, component));
  }
  containsComponent(root, target) {
    if (root === target)
      return true;
    if (!(root instanceof Container))
      return false;
    return root.children.some((child) => this.containsComponent(child, target));
  }
  /**
   * Show an overlay component with configurable positioning and sizing.
   * Returns a handle to control the overlay's visibility.
   */
  showOverlay(component, options) {
    const entry = {
      component,
      ...options === void 0 ? {} : { options },
      preFocus: this.focusedComponent,
      hidden: false,
      focusOrder: ++this.focusOrderCounter
    };
    this.overlayStack.push(entry);
    if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
      this.setFocus(component);
    }
    this.terminal.hideCursor();
    this.requestRender();
    return {
      hide: () => {
        const index = this.overlayStack.indexOf(entry);
        if (index !== -1) {
          this.clearOverlayFocusRestoreFor(entry);
          this.retargetOverlayPreFocus(entry);
          this.overlayStack.splice(index, 1);
          if (this.focusedComponent === component) {
            const topVisible = this.getTopmostVisibleOverlay();
            this.setFocus(topVisible?.component ?? entry.preFocus);
          }
          if (this.overlayStack.length === 0)
            this.terminal.hideCursor();
          this.requestRender();
        }
      },
      setHidden: (hidden) => {
        if (entry.hidden === hidden)
          return;
        entry.hidden = hidden;
        if (hidden) {
          this.clearOverlayFocusRestoreFor(entry);
          if (this.focusedComponent === component) {
            const topVisible = this.getTopmostVisibleOverlay();
            this.setFocus(topVisible?.component ?? entry.preFocus);
          }
        } else {
          if (!options?.nonCapturing && this.isOverlayVisible(entry)) {
            entry.focusOrder = ++this.focusOrderCounter;
            this.setFocus(component);
          }
        }
        this.requestRender();
      },
      isHidden: () => entry.hidden,
      focus: () => {
        if (!this.overlayStack.includes(entry) || !this.isOverlayVisible(entry))
          return;
        entry.focusOrder = ++this.focusOrderCounter;
        this.setFocus(component);
        this.requestRender();
      },
      unfocus: (unfocusOptions) => {
        const isFocused = this.focusedComponent === component;
        const restoreState = this.overlayFocusRestore;
        const hasPendingRestore = restoreState.status !== "inactive" && restoreState.overlay === entry;
        if (!isFocused && !hasPendingRestore)
          return;
        if (restoreState.status === "blocked" && restoreState.overlay === entry && this.focusedComponent === restoreState.blockedBy) {
          if (unfocusOptions) {
            this.overlayFocusRestore = {
              status: "blocked",
              overlay: entry,
              blockedBy: restoreState.blockedBy,
              resume: { status: "focus-target", target: unfocusOptions.target }
            };
          } else {
            this.clearOverlayFocusRestore();
          }
          this.requestRender();
          return;
        }
        this.clearOverlayFocusRestoreFor(entry);
        if (isFocused || unfocusOptions) {
          const topVisible = this.getTopmostVisibleOverlay();
          const fallbackTarget = topVisible && topVisible !== entry ? topVisible.component : entry.preFocus;
          this.setFocus(unfocusOptions ? unfocusOptions.target : fallbackTarget);
        }
        this.requestRender();
      },
      isFocused: () => this.focusedComponent === component
    };
  }
  /** Hide the topmost overlay and restore previous focus. */
  hideOverlay() {
    const overlay = this.overlayStack[this.overlayStack.length - 1];
    if (!overlay)
      return;
    this.clearOverlayFocusRestoreFor(overlay);
    this.retargetOverlayPreFocus(overlay);
    this.overlayStack.pop();
    if (this.focusedComponent === overlay.component) {
      const topVisible = this.getTopmostVisibleOverlay();
      this.setFocus(topVisible?.component ?? overlay.preFocus);
    }
    if (this.overlayStack.length === 0)
      this.terminal.hideCursor();
    this.requestRender();
  }
  /** Check if there are any visible overlays */
  hasOverlay() {
    return this.overlayStack.some((o) => this.isOverlayVisible(o));
  }
  /** Check if the focused component is a visible overlay */
  isOverlayFocused() {
    return this.overlayStack.some((entry) => entry.component === this.focusedComponent && this.isOverlayVisible(entry));
  }
  /** Check if an overlay entry is currently visible */
  isOverlayVisible(entry) {
    if (entry.hidden)
      return false;
    if (entry.options?.visible) {
      return entry.options.visible(this.terminal.columns, this.terminal.rows);
    }
    return true;
  }
  /** Find the visual-frontmost visible capturing overlay, if any */
  getTopmostVisibleOverlay() {
    let topmost;
    for (const overlay of this.overlayStack) {
      if (overlay.options?.nonCapturing || !this.isOverlayVisible(overlay))
        continue;
      if (!topmost || overlay.focusOrder > topmost.focusOrder) {
        topmost = overlay;
      }
    }
    return topmost;
  }
  invalidate() {
    for (const root of this.getMountedRoots())
      root.invalidate();
    for (const overlay of this.overlayStack)
      overlay.component.invalidate();
  }
  start() {
    this.stopped = false;
    this.beforeTerminalStart();
    this.terminal.start((data) => this.handleTerminalInput(data), () => this.requestRender());
    this.afterTerminalStart();
    this.terminal.hideCursor();
    if (this.terminalColorSchemeNotificationsEnabled) {
      this.terminal.write("\x1B[?2031h");
    }
    this.queryCellSize();
    this.requestRender();
  }
  addInputListener(listener) {
    this.inputListeners.add(listener);
    return () => {
      this.inputListeners.delete(listener);
    };
  }
  removeInputListener(listener) {
    this.inputListeners.delete(listener);
  }
  onTerminalColorSchemeChange(listener) {
    this.terminalColorSchemeListeners.add(listener);
    return () => {
      this.terminalColorSchemeListeners.delete(listener);
    };
  }
  setTerminalColorSchemeNotifications(enabled) {
    if (this.terminalColorSchemeNotificationsEnabled === enabled) {
      return;
    }
    this.terminalColorSchemeNotificationsEnabled = enabled;
    if (!this.stopped) {
      this.terminal.write(enabled ? "\x1B[?2031h" : "\x1B[?2031l");
    }
  }
  queryCellSize() {
    if (!getCapabilities().images) {
      return;
    }
    this.terminal.write("\x1B[16t");
  }
  stop(options = {}) {
    this.stopped = true;
    this.cancelRenderTimer();
    if (this.terminalColorSchemeNotificationsEnabled) {
      this.terminal.write("\x1B[?2031l");
    }
    this.beforeTerminalStop(options);
    this.terminal.showCursor();
    this.terminal.stop();
    this.afterTerminalStop(options);
  }
  renderNow(force = false) {
    if (force)
      this.resetRenderState();
    this.renderRequested = false;
    this.cancelRenderTimer();
    this.lastRenderAt = performance.now();
    this.doRender();
  }
  requestRender(force = false) {
    if (force) {
      this.resetRenderState();
      this.requestImmediateRender();
      return;
    }
    if (this.renderRequested)
      return;
    this.renderRequested = true;
    process.nextTick(() => this.scheduleRender());
  }
  requestImmediateRender() {
    this.cancelRenderTimer();
    this.renderRequested = true;
    if (this.immediateRenderScheduled)
      return;
    this.immediateRenderScheduled = true;
    process.nextTick(() => {
      this.immediateRenderScheduled = false;
      if (this.stopped || !this.renderRequested)
        return;
      this.cancelRenderTimer();
      this.renderRequested = false;
      this.lastRenderAt = performance.now();
      this.doRender();
    });
  }
  cancelRenderTimer() {
    if (!this.renderTimer)
      return;
    clearTimeout(this.renderTimer);
    this.renderTimer = void 0;
  }
  scheduleRender() {
    if (this.stopped || this.renderTimer || !this.renderRequested) {
      return;
    }
    const elapsed = performance.now() - this.lastRenderAt;
    const delay = Math.max(0, _TuiBase.MIN_RENDER_INTERVAL_MS - elapsed);
    this.renderTimer = setTimeout(() => {
      this.renderTimer = void 0;
      if (this.stopped || !this.renderRequested) {
        return;
      }
      this.renderRequested = false;
      this.lastRenderAt = performance.now();
      this.doRender();
      if (this.renderRequested) {
        this.scheduleRender();
      }
    }, delay);
  }
  handleTerminalInput(data) {
    if (this.consumeOsc11BackgroundResponse(data)) {
      return;
    }
    if (this.consumeTerminalColorSchemeReport(data)) {
      return;
    }
    if (this.inputListeners.size > 0) {
      let current = data;
      for (const listener of this.inputListeners) {
        const result = listener(current);
        if (result?.consume) {
          return;
        }
        if (result?.data !== void 0) {
          current = result.data;
        }
      }
      if (current.length === 0) {
        return;
      }
      data = current;
    }
    if (this.consumeCellSizeResponse(data)) {
      return;
    }
    if (matchesKey(data, "shift+ctrl+d") && this.onDebug) {
      this.onDebug();
      return;
    }
    const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
    if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
      const topVisible = this.getTopmostVisibleOverlay();
      if (topVisible) {
        this.setFocus(topVisible.component);
      } else {
        this.setFocusInternal({ component: focusedOverlay.preFocus, overlayFocusRestore: "preserve" });
      }
    }
    const focusIsOverlay = this.overlayStack.some((o) => o.component === this.focusedComponent);
    if (!focusIsOverlay) {
      const restoreState = this.getVisibleOverlayFocusRestore();
      if (restoreState.status === "eligible") {
        this.setFocus(restoreState.overlay.component);
      } else if (restoreState.status === "blocked" && restoreState.blockedBy !== this.focusedComponent) {
        if (restoreState.resume.status === "restore-overlay") {
          this.setFocus(restoreState.overlay.component);
        } else {
          this.clearOverlayFocusRestore();
          this.setFocus(restoreState.resume.target);
        }
      }
    }
    if (this.focusedComponent?.handleInput) {
      if (isKeyRelease(data) && !this.focusedComponent.wantsKeyRelease) {
        return;
      }
      this.focusedComponent.handleInput(data);
      this.requestImmediateRender();
    }
  }
  consumeOsc11BackgroundResponse(data) {
    if (this.pendingOsc11BackgroundReplies <= 0) {
      return false;
    }
    if (!isOsc11BackgroundColorResponse(data)) {
      return false;
    }
    const rgb = parseOsc11BackgroundColor(data);
    this.pendingOsc11BackgroundReplies -= 1;
    const query = this.pendingOsc11BackgroundQueries.shift();
    if (query && !query.settled) {
      query.settled = true;
      if (query.timer) {
        clearTimeout(query.timer);
        query.timer = void 0;
      }
      query.resolve?.(rgb);
      query.resolve = void 0;
    }
    return true;
  }
  consumeTerminalColorSchemeReport(data) {
    const scheme = parseTerminalColorSchemeReport(data);
    if (!scheme) {
      return false;
    }
    for (const listener of this.terminalColorSchemeListeners) {
      listener(scheme);
    }
    return true;
  }
  consumeCellSizeResponse(data) {
    const match = data.match(/^\x1b\[6;(\d+);(\d+)t$/);
    if (!match) {
      return false;
    }
    const heightPx = parseInt(match[1], 10);
    const widthPx = parseInt(match[2], 10);
    if (heightPx <= 0 || widthPx <= 0) {
      return true;
    }
    setCellDimensions({ widthPx, heightPx });
    this.invalidate();
    this.requestRender();
    return true;
  }
  /**
   * Resolve overlay layout from options.
   * Returns { width, row, col, maxHeight } for rendering.
   */
  resolveOverlayLayout(options, overlayHeight, termWidth, termHeight) {
    const opt = options ?? {};
    const margin = typeof opt.margin === "number" ? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin } : opt.margin ?? {};
    const marginTop = Math.max(0, margin.top ?? 0);
    const marginRight = Math.max(0, margin.right ?? 0);
    const marginBottom = Math.max(0, margin.bottom ?? 0);
    const marginLeft = Math.max(0, margin.left ?? 0);
    const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
    const availHeight = Math.max(1, termHeight - marginTop - marginBottom);
    let width = parseSizeValue(opt.width, termWidth) ?? Math.min(80, availWidth);
    if (opt.minWidth !== void 0) {
      width = Math.max(width, opt.minWidth);
    }
    width = Math.max(1, Math.min(width, availWidth));
    let maxHeight = parseSizeValue(opt.maxHeight, termHeight);
    if (maxHeight !== void 0) {
      maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
    }
    const effectiveHeight = maxHeight !== void 0 ? Math.min(overlayHeight, maxHeight) : overlayHeight;
    let row;
    let col;
    if (opt.row !== void 0) {
      if (typeof opt.row === "string") {
        const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
        if (match) {
          const maxRow = Math.max(0, availHeight - effectiveHeight);
          const percent = parseFloat(match[1]) / 100;
          row = marginTop + Math.floor(maxRow * percent);
        } else {
          row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
        }
      } else {
        row = opt.row;
      }
    } else {
      const anchor = opt.anchor ?? "center";
      row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
    }
    if (opt.col !== void 0) {
      if (typeof opt.col === "string") {
        const match = opt.col.match(/^(\d+(?:\.\d+)?)%$/);
        if (match) {
          const maxCol = Math.max(0, availWidth - width);
          const percent = parseFloat(match[1]) / 100;
          col = marginLeft + Math.floor(maxCol * percent);
        } else {
          col = this.resolveAnchorCol("center", width, availWidth, marginLeft);
        }
      } else {
        col = opt.col;
      }
    } else {
      const anchor = opt.anchor ?? "center";
      col = this.resolveAnchorCol(anchor, width, availWidth, marginLeft);
    }
    if (opt.offsetY !== void 0)
      row += opt.offsetY;
    if (opt.offsetX !== void 0)
      col += opt.offsetX;
    row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
    col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));
    return { width, row, col, maxHeight };
  }
  resolveAnchorRow(anchor, height, availHeight, marginTop) {
    switch (anchor) {
      case "top-left":
      case "top-center":
      case "top-right":
        return marginTop;
      case "bottom-left":
      case "bottom-center":
      case "bottom-right":
        return marginTop + availHeight - height;
      case "left-center":
      case "center":
      case "right-center":
        return marginTop + Math.floor((availHeight - height) / 2);
    }
  }
  resolveAnchorCol(anchor, width, availWidth, marginLeft) {
    switch (anchor) {
      case "top-left":
      case "left-center":
      case "bottom-left":
        return marginLeft;
      case "top-right":
      case "right-center":
      case "bottom-right":
        return marginLeft + availWidth - width;
      case "top-center":
      case "center":
      case "bottom-center":
        return marginLeft + Math.floor((availWidth - width) / 2);
    }
  }
  /** Composite all overlays into content lines (sorted by focusOrder, higher = on top). */
  compositeOverlays(lines, termWidth, termHeight) {
    if (this.overlayStack.length === 0)
      return lines;
    const result = [...lines];
    const rendered = [];
    let minLinesNeeded = result.length;
    const visibleEntries = this.overlayStack.filter((e) => this.isOverlayVisible(e));
    visibleEntries.sort((a, b2) => a.focusOrder - b2.focusOrder);
    for (const entry of visibleEntries) {
      const { component, options } = entry;
      const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);
      let overlayLines = component.render(width);
      if (maxHeight !== void 0 && overlayLines.length > maxHeight) {
        overlayLines = overlayLines.slice(0, maxHeight);
      }
      const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);
      rendered.push({ overlayLines, row, col, w: width });
      minLinesNeeded = Math.max(minLinesNeeded, row + overlayLines.length);
    }
    const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);
    while (result.length < workingHeight) {
      result.push("");
    }
    const viewportStart = Math.max(0, workingHeight - termHeight);
    for (const { overlayLines, row, col, w: w2 } of rendered) {
      for (let i = 0; i < overlayLines.length; i++) {
        const idx = viewportStart + row + i;
        if (idx >= 0 && idx < result.length) {
          const truncatedOverlayLine = visibleWidth(overlayLines[i]) > w2 ? sliceByColumn(overlayLines[i], 0, w2, true) : overlayLines[i];
          result[idx] = this.compositeLineAt(result[idx], truncatedOverlayLine, col, w2, termWidth);
        }
      }
    }
    return result;
  }
  applyLineResets(lines) {
    const reset = SEGMENT_RESET;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!isImageLine(line)) {
        lines[i] = normalizeTerminalOutput(line) + reset;
      }
    }
    return lines;
  }
  compositeLineAt(baseLine, overlayLine, startCol, overlayWidth, totalWidth) {
    return compositeTuiLine(baseLine, overlayLine, startCol, overlayWidth, totalWidth);
  }
  /**
   * Find and extract cursor position from rendered lines.
   * Searches for CURSOR_MARKER, calculates its position, and strips it from the output.
   * Only scans the bottom terminal height lines (visible viewport).
   * @param lines - Rendered lines to search
   * @param height - Terminal height (visible viewport size)
   * @returns Cursor position { row, col } or null if no marker found
   */
  extractCursorPosition(lines, height) {
    const viewportTop = Math.max(0, lines.length - height);
    for (let row = lines.length - 1; row >= viewportTop; row--) {
      const line = lines[row];
      const markerIndex = line.indexOf(CURSOR_MARKER);
      if (markerIndex !== -1) {
        const beforeMarker = line.slice(0, markerIndex);
        const col = visibleWidth(beforeMarker);
        lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);
        return { row, col };
      }
    }
    return null;
  }
  /**
   * Query the terminal's default background color with OSC 11 (`ESC ] 11 ; ? BEL`).
   * @param timeoutMs Query timeout in milliseconds.
   * @returns Promise containing the parsed RGB color, or undefined if it times out or fails to parse.
   */
  queryTerminalBackgroundColor({ timeoutMs }) {
    return new Promise((resolve4) => {
      const query = {
        settled: false,
        resolve: resolve4,
        timer: void 0
      };
      query.timer = setTimeout(() => {
        if (query.settled) {
          return;
        }
        query.settled = true;
        query.timer = void 0;
        query.resolve?.(void 0);
        query.resolve = void 0;
      }, timeoutMs);
      this.pendingOsc11BackgroundQueries.push(query);
      this.pendingOsc11BackgroundReplies += 1;
      this.terminal.write("\x1B]11;?\x07");
    });
  }
  /**
   * Query the terminal's color-scheme preference with DSR (`CSI ? 996 n`).
   * Terminals that support the color palette notification protocol reply with
   * `CSI ? 997 ; 1 n` for dark or `CSI ? 997 ; 2 n` for light.
   */
  queryTerminalColorScheme({ timeoutMs }) {
    return new Promise((resolve4) => {
      let settled = false;
      let timer;
      let unsubscribe = () => {
      };
      const settle = (scheme) => {
        if (settled)
          return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = void 0;
        }
        unsubscribe();
        resolve4(scheme);
      };
      unsubscribe = this.onTerminalColorSchemeChange(settle);
      timer = setTimeout(() => settle(void 0), timeoutMs);
      this.terminal.write("\x1B[?996n");
    });
  }
};

// node_modules/@earendil-works/pi-tui/dist/undo-stack.js
var UndoStack = class {
  stack = [];
  /** Push a deep clone of the given state onto the stack. */
  push(state) {
    this.stack.push(structuredClone(state));
  }
  /** Pop and return the most recent snapshot, or undefined if empty. */
  pop() {
    return this.stack.pop();
  }
  /** Remove all snapshots. */
  clear() {
    this.stack.length = 0;
  }
  get length() {
    return this.stack.length;
  }
};

// node_modules/@earendil-works/pi-tui/dist/word-navigation.js
var wordSegmenter2 = getWordSegmenter();
function findWordBackward(text, cursor, options) {
  if (cursor <= 0)
    return 0;
  const textBeforeCursor = text.slice(0, cursor);
  const segmentFn = options?.segment;
  const isAtomic = options?.isAtomicSegment;
  const segments = segmentFn ? [...segmentFn(textBeforeCursor)] : [...wordSegmenter2.segment(textBeforeCursor)];
  let newCursor = cursor;
  while (segments.length > 0 && !isAtomic?.(segments[segments.length - 1]?.segment || "") && isWhitespaceChar(segments[segments.length - 1]?.segment || "")) {
    newCursor -= segments.pop()?.segment.length || 0;
  }
  if (segments.length === 0)
    return newCursor;
  const last = segments[segments.length - 1];
  if (isAtomic?.(last.segment)) {
    newCursor -= last.segment.length;
  } else if (last.isWordLike) {
    const segment = last.segment;
    const matches = [...segment.matchAll(new RegExp(PUNCTUATION_REGEX, "g"))];
    if (matches.length <= 0) {
      newCursor -= segment.length;
    } else {
      const lastMatch = matches[matches.length - 1];
      newCursor -= segment.length - (lastMatch.index + lastMatch[0].length);
    }
  } else {
    while (segments.length > 0 && !isAtomic?.(segments[segments.length - 1]?.segment || "") && !segments[segments.length - 1]?.isWordLike && !isWhitespaceChar(segments[segments.length - 1]?.segment || "")) {
      newCursor -= segments.pop()?.segment.length || 0;
    }
  }
  return newCursor;
}
function findWordForward(text, cursor, options) {
  if (cursor >= text.length)
    return text.length;
  const textAfterCursor = text.slice(cursor);
  const segmentFn = options?.segment;
  const isAtomic = options?.isAtomicSegment;
  const segments = segmentFn ? segmentFn(textAfterCursor) : wordSegmenter2.segment(textAfterCursor);
  const iterator = segments[Symbol.iterator]();
  let next = iterator.next();
  let newCursor = cursor;
  while (!next.done && !isAtomic?.(next.value.segment) && isWhitespaceChar(next.value.segment)) {
    newCursor += next.value.segment.length;
    next = iterator.next();
  }
  if (next.done)
    return newCursor;
  if (isAtomic?.(next.value.segment)) {
    newCursor += next.value.segment.length;
  } else if (next.value.isWordLike) {
    newCursor += PUNCTUATION_REGEX.exec(next.value.segment)?.index ?? next.value.segment.length;
  } else {
    while (!next.done && !isAtomic?.(next.value.segment) && !next.value.isWordLike && !isWhitespaceChar(next.value.segment)) {
      newCursor += next.value.segment.length;
      next = iterator.next();
    }
  }
  return newCursor;
}

// node_modules/@earendil-works/pi-tui/dist/components/editor.js
var graphemeSegmenter2 = getGraphemeSegmenter();
var wordSegmenter3 = getWordSegmenter();

// node_modules/@earendil-works/pi-tui/dist/layout-node.js
var LAYOUT_NODE = /* @__PURE__ */ Symbol.for("@earendil-works/pi-tui/layout-node");
function getLayoutNode(component) {
  const candidate = component;
  return typeof candidate[LAYOUT_NODE] === "function" ? candidate[LAYOUT_NODE]() : void 0;
}

// node_modules/@earendil-works/pi-tui/dist/components/stack.js
function isStackEntry(child) {
  return !("render" in child);
}
function normalizeSize(value, fallback) {
  return value === void 0 || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
}
var Stack = class extends Container {
  entries = [];
  gap;
  align;
  constructor(children = [], options = {}) {
    super();
    this.gap = normalizeSize(options.gap, 0);
    this.align = options.align ?? "stretch";
    for (const child of children) {
      if (isStackEntry(child))
        this.addChild(child.component, child);
      else
        this.addChild(child);
    }
  }
  addChild(component, options = {}) {
    super.addChild(component);
    this.entries.push({
      component,
      ...options.basis === void 0 ? {} : { basis: options.basis },
      ...options.grow === void 0 ? {} : { grow: normalizeSize(options.grow, 0) },
      ...options.shrink === void 0 ? {} : { shrink: normalizeSize(options.shrink, 1) },
      ...options.minSize === void 0 ? {} : { minSize: normalizeSize(options.minSize, 0) },
      ...options.maxSize === void 0 ? {} : { maxSize: normalizeSize(options.maxSize, Number.MAX_SAFE_INTEGER) },
      ...options.visible === void 0 ? {} : { visible: options.visible }
    });
  }
  removeChild(component) {
    super.removeChild(component);
    const index = this.entries.findIndex((entry) => entry.component === component);
    if (index !== -1)
      this.entries.splice(index, 1);
  }
  clear() {
    super.clear();
    this.entries.length = 0;
  }
  [LAYOUT_NODE]() {
    return {
      type: this.layoutType,
      entries: this.entries,
      gap: this.gap,
      align: this.align
    };
  }
};
function visibleStackEntries(entries, viewport) {
  return entries.filter((entry) => entry.visible?.(viewport) ?? true);
}
function clampSize(size, entry) {
  const min = Math.max(0, Math.floor(entry.minSize ?? 0));
  const max = Math.max(min, Math.floor(entry.maxSize ?? Number.MAX_SAFE_INTEGER));
  return Math.max(min, Math.min(max, Math.max(0, Math.floor(size))));
}
function distribute(sizes, entries, amount, mode) {
  let remaining = amount;
  while (remaining > 0) {
    const candidates = entries.map((entry, index) => ({ entry, index })).filter(({ entry, index }) => {
      if (mode === "grow") {
        return (entry.grow ?? 0) > 0 && sizes[index] < (entry.maxSize ?? Number.MAX_SAFE_INTEGER);
      }
      return (entry.shrink ?? 1) > 0 && sizes[index] > (entry.minSize ?? 0);
    });
    if (candidates.length === 0)
      return;
    const totalWeight = candidates.reduce((sum, { entry, index }) => {
      return sum + (mode === "grow" ? entry.grow ?? 0 : (entry.shrink ?? 1) * Math.max(1, sizes[index]));
    }, 0);
    let distributed = 0;
    for (const { entry, index } of candidates) {
      if (remaining <= 0)
        break;
      const weight = mode === "grow" ? entry.grow ?? 0 : (entry.shrink ?? 1) * Math.max(1, sizes[index]);
      const proposed = Math.max(1, Math.floor(remaining * weight / totalWeight));
      const capacity = mode === "grow" ? (entry.maxSize ?? Number.MAX_SAFE_INTEGER) - sizes[index] : sizes[index] - (entry.minSize ?? 0);
      const delta = Math.min(remaining, proposed, capacity);
      if (delta <= 0)
        continue;
      sizes[index] = sizes[index] + (mode === "grow" ? delta : -delta);
      remaining -= delta;
      distributed += delta;
    }
    if (distributed === 0)
      return;
  }
}
function allocateStackSizes(entries, intrinsicSizes, availableSize, gap) {
  const sizes = entries.map((entry, index) => clampSize(entry.basis === void 0 || entry.basis === "auto" ? intrinsicSizes[index] ?? 0 : entry.basis, entry));
  if (availableSize === void 0)
    return sizes;
  const contentSize = Math.max(0, Math.floor(availableSize) - Math.max(0, entries.length - 1) * gap);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total < contentSize)
    distribute(sizes, entries, contentSize - total, "grow");
  else if (total > contentSize)
    distribute(sizes, entries, total - contentSize, "shrink");
  return sizes;
}

// node_modules/@earendil-works/pi-tui/dist/components/h-stack.js
var HStack = class extends Stack {
  layoutType = "hstack";
  constructor(children = [], options = {}) {
    super(children, options);
  }
  render(width) {
    const safeWidth = Math.max(1, width);
    const viewport = { width: safeWidth, height: Number.MAX_SAFE_INTEGER };
    const entries = visibleStackEntries(this.entries, viewport);
    if (entries.length === 0)
      return [];
    const intrinsicWidths = entries.map((entry) => {
      const lines = entry.component.render(safeWidth);
      return lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
    });
    const widths = allocateStackSizes(entries, intrinsicWidths, safeWidth, this.gap);
    const rendered = entries.map((entry, index) => widths[index] === 0 ? [] : entry.component.render(widths[index]));
    const height = rendered.reduce((max, lines) => Math.max(max, lines.length), 0);
    const result = Array.from({ length: height }, () => "");
    let x2 = 0;
    for (let index = 0; index < rendered.length; index++) {
      const lines = rendered[index];
      const childWidth = widths[index];
      let offset = 0;
      if (this.align === "center")
        offset = Math.floor((height - lines.length) / 2);
      else if (this.align === "end")
        offset = height - lines.length;
      for (let row = 0; row < lines.length; row++) {
        const target = row + offset;
        if (target < 0 || target >= result.length)
          continue;
        result[target] = compositeTuiLine(result[target], lines[row], x2, childWidth, safeWidth);
      }
      x2 += childWidth + this.gap;
    }
    return result;
  }
};

// node_modules/@earendil-works/pi-tui/dist/components/input.js
var segmenter = getGraphemeSegmenter();
var Input = class {
  value = "";
  cursor = 0;
  // Cursor position in the value
  onSubmit;
  onEscape;
  /** Focusable interface - set by TUI when focus changes */
  focused = false;
  // Bracketed paste mode buffering
  pasteBuffer = "";
  isInPaste = false;
  // Kill ring for Emacs-style kill/yank operations
  killRing = new KillRing();
  lastAction = null;
  // Undo support
  undoStack = new UndoStack();
  getValue() {
    return this.value;
  }
  setValue(value) {
    this.value = value;
    this.cursor = Math.min(this.cursor, value.length);
  }
  handleInput(data) {
    if (data.includes("\x1B[200~")) {
      this.isInPaste = true;
      this.pasteBuffer = "";
      data = data.replace("\x1B[200~", "");
    }
    if (this.isInPaste) {
      this.pasteBuffer += data;
      const endIndex = this.pasteBuffer.indexOf("\x1B[201~");
      if (endIndex !== -1) {
        const pasteContent = this.pasteBuffer.substring(0, endIndex);
        this.handlePaste(pasteContent);
        this.isInPaste = false;
        const remaining = this.pasteBuffer.substring(endIndex + 6);
        this.pasteBuffer = "";
        if (remaining) {
          this.handleInput(remaining);
        }
      }
      return;
    }
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.cancel")) {
      if (this.onEscape)
        this.onEscape();
      return;
    }
    if (kb.matches(data, "tui.editor.undo")) {
      this.undo();
      return;
    }
    if (kb.matches(data, "tui.input.submit") || data === "\n") {
      if (this.onSubmit)
        this.onSubmit(this.value);
      return;
    }
    if (kb.matches(data, "tui.editor.deleteCharBackward")) {
      this.handleBackspace();
      return;
    }
    if (kb.matches(data, "tui.editor.deleteCharForward")) {
      this.handleForwardDelete();
      return;
    }
    if (kb.matches(data, "tui.editor.deleteWordBackward")) {
      this.deleteWordBackwards();
      return;
    }
    if (kb.matches(data, "tui.editor.deleteWordForward")) {
      this.deleteWordForward();
      return;
    }
    if (kb.matches(data, "tui.editor.deleteToLineStart")) {
      this.deleteToLineStart();
      return;
    }
    if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
      this.deleteToLineEnd();
      return;
    }
    if (kb.matches(data, "tui.editor.yank")) {
      this.yank();
      return;
    }
    if (kb.matches(data, "tui.editor.yankPop")) {
      this.yankPop();
      return;
    }
    if (kb.matches(data, "tui.editor.cursorLeft")) {
      this.lastAction = null;
      if (this.cursor > 0) {
        const beforeCursor = this.value.slice(0, this.cursor);
        const graphemes = [...segmenter.segment(beforeCursor)];
        const lastGrapheme = graphemes[graphemes.length - 1];
        this.cursor -= lastGrapheme ? lastGrapheme.segment.length : 1;
      }
      return;
    }
    if (kb.matches(data, "tui.editor.cursorRight")) {
      this.lastAction = null;
      if (this.cursor < this.value.length) {
        const afterCursor = this.value.slice(this.cursor);
        const graphemes = [...segmenter.segment(afterCursor)];
        const firstGrapheme = graphemes[0];
        this.cursor += firstGrapheme ? firstGrapheme.segment.length : 1;
      }
      return;
    }
    if (kb.matches(data, "tui.editor.cursorLineStart")) {
      this.lastAction = null;
      this.cursor = 0;
      return;
    }
    if (kb.matches(data, "tui.editor.cursorLineEnd")) {
      this.lastAction = null;
      this.cursor = this.value.length;
      return;
    }
    if (kb.matches(data, "tui.editor.cursorWordLeft")) {
      this.moveWordBackwards();
      return;
    }
    if (kb.matches(data, "tui.editor.cursorWordRight")) {
      this.moveWordForwards();
      return;
    }
    const kittyPrintable = decodeKittyPrintable(data);
    if (kittyPrintable !== void 0) {
      this.insertCharacter(kittyPrintable);
      return;
    }
    const hasControlChars = [...data].some((ch) => {
      const code = ch.charCodeAt(0);
      return code < 32 || code === 127 || code >= 128 && code <= 159;
    });
    if (!hasControlChars) {
      this.insertCharacter(data);
    }
  }
  insertCharacter(char) {
    if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
      this.pushUndo();
    }
    this.lastAction = "type-word";
    this.value = this.value.slice(0, this.cursor) + char + this.value.slice(this.cursor);
    this.cursor += char.length;
  }
  handleBackspace() {
    this.lastAction = null;
    if (this.cursor > 0) {
      this.pushUndo();
      const beforeCursor = this.value.slice(0, this.cursor);
      const graphemes = [...segmenter.segment(beforeCursor)];
      const lastGrapheme = graphemes[graphemes.length - 1];
      const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;
      this.value = this.value.slice(0, this.cursor - graphemeLength) + this.value.slice(this.cursor);
      this.cursor -= graphemeLength;
    }
  }
  handleForwardDelete() {
    this.lastAction = null;
    if (this.cursor < this.value.length) {
      this.pushUndo();
      const afterCursor = this.value.slice(this.cursor);
      const graphemes = [...segmenter.segment(afterCursor)];
      const firstGrapheme = graphemes[0];
      const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;
      this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + graphemeLength);
    }
  }
  deleteToLineStart() {
    if (this.cursor === 0)
      return;
    this.pushUndo();
    const deletedText = this.value.slice(0, this.cursor);
    this.killRing.push(deletedText, { prepend: true, accumulate: this.lastAction === "kill" });
    this.lastAction = "kill";
    this.value = this.value.slice(this.cursor);
    this.cursor = 0;
  }
  deleteToLineEnd() {
    if (this.cursor >= this.value.length)
      return;
    this.pushUndo();
    const deletedText = this.value.slice(this.cursor);
    this.killRing.push(deletedText, { prepend: false, accumulate: this.lastAction === "kill" });
    this.lastAction = "kill";
    this.value = this.value.slice(0, this.cursor);
  }
  deleteWordBackwards() {
    if (this.cursor === 0)
      return;
    const wasKill = this.lastAction === "kill";
    this.pushUndo();
    const oldCursor = this.cursor;
    this.moveWordBackwards();
    const deleteFrom = this.cursor;
    this.cursor = oldCursor;
    const deletedText = this.value.slice(deleteFrom, this.cursor);
    this.killRing.push(deletedText, { prepend: true, accumulate: wasKill });
    this.lastAction = "kill";
    this.value = this.value.slice(0, deleteFrom) + this.value.slice(this.cursor);
    this.cursor = deleteFrom;
  }
  deleteWordForward() {
    if (this.cursor >= this.value.length)
      return;
    const wasKill = this.lastAction === "kill";
    this.pushUndo();
    const oldCursor = this.cursor;
    this.moveWordForwards();
    const deleteTo = this.cursor;
    this.cursor = oldCursor;
    const deletedText = this.value.slice(this.cursor, deleteTo);
    this.killRing.push(deletedText, { prepend: false, accumulate: wasKill });
    this.lastAction = "kill";
    this.value = this.value.slice(0, this.cursor) + this.value.slice(deleteTo);
  }
  yank() {
    const text = this.killRing.peek();
    if (!text)
      return;
    this.pushUndo();
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
    this.lastAction = "yank";
  }
  yankPop() {
    if (this.lastAction !== "yank" || this.killRing.length <= 1)
      return;
    this.pushUndo();
    const prevText = this.killRing.peek() || "";
    this.value = this.value.slice(0, this.cursor - prevText.length) + this.value.slice(this.cursor);
    this.cursor -= prevText.length;
    this.killRing.rotate();
    const text = this.killRing.peek() || "";
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
    this.cursor += text.length;
    this.lastAction = "yank";
  }
  pushUndo() {
    this.undoStack.push({ value: this.value, cursor: this.cursor });
  }
  undo() {
    const snapshot = this.undoStack.pop();
    if (!snapshot)
      return;
    this.value = snapshot.value;
    this.cursor = snapshot.cursor;
    this.lastAction = null;
  }
  moveWordBackwards() {
    if (this.cursor === 0)
      return;
    this.lastAction = null;
    this.cursor = findWordBackward(this.value, this.cursor);
  }
  moveWordForwards() {
    if (this.cursor >= this.value.length)
      return;
    this.lastAction = null;
    this.cursor = findWordForward(this.value, this.cursor);
  }
  handlePaste(pastedText) {
    this.lastAction = null;
    this.pushUndo();
    const cleanText = pastedText.replace(/\r\n/g, "").replace(/\r/g, "").replace(/\n/g, "").replace(/\t/g, "    ");
    this.value = this.value.slice(0, this.cursor) + cleanText + this.value.slice(this.cursor);
    this.cursor += cleanText.length;
  }
  invalidate() {
  }
  render(width) {
    const prompt = "> ";
    const availableWidth = width - prompt.length;
    if (availableWidth <= 0) {
      return [prompt];
    }
    let visibleText = "";
    let cursorDisplay = this.cursor;
    const totalWidth = visibleWidth(this.value);
    if (totalWidth < availableWidth) {
      visibleText = this.value;
    } else {
      const scrollWidth = this.cursor === this.value.length ? availableWidth - 1 : availableWidth;
      const cursorCol = visibleWidth(this.value.slice(0, this.cursor));
      if (scrollWidth > 0) {
        const halfWidth = Math.floor(scrollWidth / 2);
        let startCol = 0;
        if (cursorCol < halfWidth) {
          startCol = 0;
        } else if (cursorCol > totalWidth - halfWidth) {
          startCol = Math.max(0, totalWidth - scrollWidth);
        } else {
          startCol = Math.max(0, cursorCol - halfWidth);
        }
        visibleText = sliceByColumn(this.value, startCol, scrollWidth, true);
        const beforeCursor2 = sliceByColumn(this.value, startCol, Math.max(0, cursorCol - startCol), true);
        cursorDisplay = beforeCursor2.length;
      } else {
        visibleText = "";
        cursorDisplay = 0;
      }
    }
    const graphemes = [...segmenter.segment(visibleText.slice(cursorDisplay))];
    const cursorGrapheme = graphemes[0];
    const beforeCursor = visibleText.slice(0, cursorDisplay);
    const atCursor = cursorGrapheme?.segment ?? " ";
    const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);
    const marker = this.focused ? CURSOR_MARKER : "";
    const cursorChar = `\x1B[7m${atCursor}\x1B[27m`;
    const textWithCursor = beforeCursor + marker + cursorChar + afterCursor;
    const visualLength = visibleWidth(textWithCursor);
    const padding = " ".repeat(Math.max(0, availableWidth - visualLength));
    const line = prompt + textWithCursor + padding;
    return [line];
  }
};

// node_modules/@earendil-works/pi-tui/dist/components/markdown.js
var STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;
var StrictStrikethroughTokenizer = class extends w {
  del(src) {
    const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
    if (!match) {
      return void 0;
    }
    const text = match[2];
    return {
      type: "del",
      raw: match[0],
      text,
      tokens: this.lexer.inlineTokens(text)
    };
  }
};
function isEscaped(source, index) {
  let backslashes = 0;
  for (let position = index - 1; position >= 0 && source[position] === "\\"; position--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}
function findClosingDelimiter(source, closing, start) {
  let index = source.indexOf(closing, start);
  while (index >= 0 && isEscaped(source, index)) {
    index = source.indexOf(closing, index + closing.length);
  }
  return index;
}
function looksLikePendingDollarMath(source) {
  return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source);
}
function tokenizeInlineLatex(source) {
  let opening = "";
  let closing = "";
  if (source.startsWith("$$")) {
    opening = "$$";
    closing = "$$";
  } else if (source.startsWith("\\(")) {
    opening = "\\(";
    closing = "\\)";
  } else if (source.startsWith("\\[")) {
    opening = "\\[";
    closing = "\\]";
  } else if (source.startsWith("$") && !/^\$\s/.test(source)) {
    opening = "$";
    closing = "$";
  } else {
    return void 0;
  }
  const closingIndex = findClosingDelimiter(source, closing, opening.length);
  if (closingIndex >= 0 && opening === "$" && (/\s$/.test(source.slice(opening.length, closingIndex)) || /^\d/.test(source.slice(closingIndex + 1)) || /^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(source.slice(opening.length, closingIndex)) && /^[A-Za-z_][A-Za-z0-9_]*/.test(source.slice(closingIndex + 1)) || source.slice(opening.length, closingIndex).includes("`"))) {
    return void 0;
  }
  if (closingIndex < 0) {
    const pendingSource = source.slice(opening.length);
    if (opening.startsWith("\\") || looksLikePendingDollarMath(pendingSource)) {
      return { type: "latex", raw: source, text: pendingSource, pending: true };
    }
    return void 0;
  }
  const text = source.slice(opening.length, closingIndex);
  if (!text || text.includes("\n")) {
    return void 0;
  }
  const raw = source.slice(0, closingIndex + closing.length);
  return { type: "latex", raw, text };
}
function tokenizeBlockLatex(source) {
  const dollarMatch = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
  if (dollarMatch?.[1]) {
    return { type: "latexBlock", raw: dollarMatch[0], text: dollarMatch[1].trim() };
  }
  const bracketMatch = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source);
  if (bracketMatch?.[1]) {
    return { type: "latexBlock", raw: bracketMatch[0], text: bracketMatch[1].trim() };
  }
  const pendingBracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
  if (pendingBracket) {
    return { type: "latexBlock", raw: pendingBracket[0], text: pendingBracket[1], pending: true };
  }
  const pendingDollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
  if (pendingDollar?.[1] && looksLikePendingDollarMath(pendingDollar[1])) {
    return { type: "latexBlock", raw: pendingDollar[0], text: pendingDollar[1], pending: true };
  }
  return void 0;
}
var LATEX_MARKDOWN_EXTENSIONS = [
  {
    name: "latexBlock",
    level: "block",
    start(source) {
      const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
      return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : void 0;
    },
    tokenizer: tokenizeBlockLatex
  },
  {
    name: "latex",
    level: "inline",
    start(source) {
      const indices = [source.indexOf("$"), source.indexOf("\\("), source.indexOf("\\[")].filter((index) => index >= 0);
      return indices.length > 0 ? Math.min(...indices) : void 0;
    },
    tokenizer: tokenizeInlineLatex
  }
];
var markdownParser = new q();
markdownParser.setOptions({
  tokenizer: new StrictStrikethroughTokenizer()
});
markdownParser.use({ extensions: [...LATEX_MARKDOWN_EXTENSIONS] });

// node_modules/@earendil-works/pi-tui/dist/components/scroll-view.js
var ScrollView = class extends Container {
  child;
  followEnd;
  primary;
  overscroll;
  scrollbarStyle;
  currentScrollbar;
  scrollbarHideDelayMs;
  currentScrollTop = 0;
  contentHeight = 0;
  currentViewportHeight = 0;
  followingEnd;
  followSuppressedAtEnd = false;
  requestRenderCallback;
  transientScrollbarVisible = false;
  scrollbarActive = false;
  scrollbarHideTimer;
  constructor(component, options = {}) {
    super();
    if (options.axis !== void 0 && options.axis !== "vertical") {
      throw new Error(`Unsupported ScrollView axis: ${options.axis}`);
    }
    this.child = component;
    this.children.push(component);
    this.followEnd = (options.follow ?? "none") === "end";
    this.followingEnd = this.followEnd;
    this.primary = options.primary ?? false;
    this.overscroll = options.overscroll ?? "chain";
    this.currentScrollbar = options.scrollbar ?? "hidden";
    this.scrollbarStyle = options.scrollbarStyle ?? ((text) => `\x1B[100m${text}\x1B[49m`);
    this.scrollbarHideDelayMs = Math.max(0, Math.floor(options.scrollbarHideDelayMs ?? 1e3));
  }
  get scrollTop() {
    return this.currentScrollTop;
  }
  get isFollowingEnd() {
    return this.followingEnd;
  }
  get viewportHeight() {
    return this.currentViewportHeight;
  }
  get scrollbar() {
    return this.currentScrollbar;
  }
  get isScrollbarVisible() {
    if (this.scrollbar === "always")
      return this.currentViewportHeight > 0;
    return this.scrollbar === "auto" && this.contentHeight > this.currentViewportHeight && this.transientScrollbarVisible;
  }
  setScrollbar(scrollbar) {
    if (scrollbar === this.currentScrollbar)
      return;
    this.currentScrollbar = scrollbar;
    if (scrollbar !== "auto")
      this.hideTransientScrollbar();
    else if (this.scrollbarActive)
      this.markScrollbarActivity();
    this.requestRenderCallback?.();
  }
  getContentWidth(width) {
    return this.scrollbar === "always" && width > 1 ? width - 1 : width;
  }
  markScrollbarActivity() {
    if (this.scrollbar !== "auto" || this.contentHeight <= this.currentViewportHeight)
      return;
    this.transientScrollbarVisible = true;
    if (this.scrollbarHideTimer) {
      clearTimeout(this.scrollbarHideTimer);
      this.scrollbarHideTimer = void 0;
    }
    if (this.scrollbarActive)
      return;
    this.scrollbarHideTimer = setTimeout(() => {
      this.scrollbarHideTimer = void 0;
      this.transientScrollbarVisible = false;
      this.requestRenderCallback?.();
    }, this.scrollbarHideDelayMs);
    this.scrollbarHideTimer.unref();
  }
  hideTransientScrollbar() {
    this.transientScrollbarVisible = false;
    if (!this.scrollbarHideTimer)
      return;
    clearTimeout(this.scrollbarHideTimer);
    this.scrollbarHideTimer = void 0;
  }
  setScrollbarActive(active) {
    if (active === this.scrollbarActive)
      return;
    this.scrollbarActive = active;
    this.markScrollbarActivity();
  }
  scrollTo(scrollTop, options = {}) {
    const requested = Number.isFinite(scrollTop) ? Math.trunc(scrollTop) : this.currentScrollTop;
    const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
    const next = Math.max(0, Math.min(maxScrollTop, requested));
    const nextFollowSuppressedAtEnd = options.disableFollow === true && next === maxScrollTop;
    const nextFollowingEnd = !nextFollowSuppressedAtEnd && this.followEnd && next === maxScrollTop;
    if (next === this.currentScrollTop && nextFollowingEnd === this.followingEnd && nextFollowSuppressedAtEnd === this.followSuppressedAtEnd) {
      return;
    }
    const moved = next !== this.currentScrollTop;
    this.currentScrollTop = next;
    this.followingEnd = nextFollowingEnd;
    this.followSuppressedAtEnd = nextFollowSuppressedAtEnd;
    if (moved)
      this.markScrollbarActivity();
    this.requestRenderCallback?.();
  }
  scrollBy(lines) {
    const requested = Number.isFinite(lines) ? Math.trunc(lines) : 0;
    if (requested === 0)
      return 0;
    const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
    const start = this.followingEnd ? maxScrollTop : this.currentScrollTop;
    const next = Math.max(0, Math.min(maxScrollTop, start + requested));
    const moved = next - start;
    const wasFollowingEnd = this.followingEnd;
    this.currentScrollTop = next;
    this.followingEnd = this.followEnd && next === maxScrollTop;
    this.followSuppressedAtEnd = false;
    if (moved !== 0)
      this.markScrollbarActivity();
    if (moved !== 0 || this.followingEnd !== wasFollowingEnd)
      this.requestRenderCallback?.();
    return requested - moved;
  }
  scrollToStart() {
    const changed = this.currentScrollTop !== 0 || this.followingEnd !== (this.followEnd && this.contentHeight <= this.currentViewportHeight);
    this.currentScrollTop = 0;
    this.followingEnd = this.followEnd && this.contentHeight <= this.currentViewportHeight;
    this.followSuppressedAtEnd = false;
    if (changed) {
      this.markScrollbarActivity();
      this.requestRenderCallback?.();
    }
  }
  scrollToEnd() {
    const next = Math.max(0, this.contentHeight - this.currentViewportHeight);
    const changed = this.currentScrollTop !== next || this.followingEnd !== this.followEnd;
    this.currentScrollTop = next;
    this.followingEnd = this.followEnd;
    this.followSuppressedAtEnd = false;
    if (changed) {
      this.markScrollbarActivity();
      this.requestRenderCallback?.();
    }
  }
  updateLayout(contentHeight, viewportHeight, requestRender) {
    this.contentHeight = Math.max(0, Math.floor(contentHeight));
    this.currentViewportHeight = Math.max(0, Math.floor(viewportHeight));
    this.requestRenderCallback = requestRender;
    const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
    if (this.followingEnd)
      this.currentScrollTop = maxScrollTop;
    else
      this.currentScrollTop = Math.max(0, Math.min(this.currentScrollTop, maxScrollTop));
    if (this.currentScrollTop < maxScrollTop)
      this.followSuppressedAtEnd = false;
    if (this.followEnd && this.currentScrollTop === maxScrollTop && !this.followSuppressedAtEnd) {
      this.followingEnd = true;
    }
    if (this.contentHeight <= this.currentViewportHeight)
      this.hideTransientScrollbar();
  }
  addChild(_component) {
    throw new Error("ScrollView has exactly one child");
  }
  removeChild(_component) {
    throw new Error("ScrollView child cannot be removed");
  }
  clear() {
    throw new Error("ScrollView child cannot be cleared");
  }
  render(width) {
    const contentWidth = this.getContentWidth(width);
    const lines = this.child.render(contentWidth);
    return contentWidth === width ? lines : lines.map((line) => `${line} `);
  }
  [LAYOUT_NODE]() {
    return { type: "scroll", component: this.child, state: this };
  }
};

// node_modules/@earendil-works/pi-tui/dist/components/settings-list.js
var SettingsList = class {
  items;
  filteredItems;
  theme;
  selectedIndex = 0;
  maxVisible;
  onChange;
  onCancel;
  searchInput;
  searchEnabled;
  // Submenu state
  submenuComponent = null;
  submenuItemIndex = null;
  navigateAfterClose = null;
  constructor(items, maxVisible, theme, onChange, onCancel, options = {}) {
    this.items = items;
    this.filteredItems = items;
    this.maxVisible = maxVisible;
    this.theme = theme;
    this.onChange = onChange;
    this.onCancel = onCancel;
    this.searchEnabled = options.enableSearch ?? false;
    if (this.searchEnabled) {
      this.searchInput = new Input();
    }
  }
  /** Update an item's currentValue */
  updateValue(id, newValue) {
    const item = this.items.find((i) => i.id === id);
    if (item) {
      item.currentValue = newValue;
    }
  }
  /** Move selection to the item with the given id (no-op if not found). */
  selectItem(id) {
    const items = this.searchEnabled ? this.filteredItems : this.items;
    const index = items.findIndex((i) => i.id === id);
    if (index !== -1) {
      this.selectedIndex = index;
    }
  }
  invalidate() {
    this.submenuComponent?.invalidate?.();
  }
  render(width) {
    if (this.submenuComponent) {
      return this.submenuComponent.render(width);
    }
    return this.renderMainList(width);
  }
  renderMainList(width) {
    const lines = [];
    if (this.searchEnabled && this.searchInput) {
      lines.push(...this.searchInput.render(width));
      lines.push("");
    }
    if (this.items.length === 0) {
      lines.push(this.theme.hint("  No settings available"));
      if (this.searchEnabled) {
        this.addHintLine(lines, width);
      }
      return lines;
    }
    const displayItems = this.searchEnabled ? this.filteredItems : this.items;
    if (displayItems.length === 0) {
      lines.push(truncateToWidth(this.theme.hint("  No matching settings"), width));
      this.addHintLine(lines, width);
      return lines;
    }
    const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), displayItems.length - this.maxVisible));
    const endIndex = Math.min(startIndex + this.maxVisible, displayItems.length);
    const maxLabelWidth = Math.min(36, Math.max(...this.items.map((item) => visibleWidth(item.label))));
    for (let i = startIndex; i < endIndex; i++) {
      const item = displayItems[i];
      if (!item)
        continue;
      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? this.theme.cursor : "  ";
      const prefixWidth = visibleWidth(prefix);
      const labelPadded = item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
      const labelText = this.theme.label(labelPadded, isSelected);
      const separator = "  ";
      const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
      const valueMaxWidth = width - usedWidth - 2;
      const valueText = this.theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ""), isSelected);
      lines.push(truncateToWidth(prefix + labelText + separator + valueText, width));
    }
    if (startIndex > 0 || endIndex < displayItems.length) {
      const scrollText = `  (${this.selectedIndex + 1}/${displayItems.length})`;
      lines.push(this.theme.hint(truncateToWidth(scrollText, width - 2, "")));
    }
    const selectedItem = displayItems[this.selectedIndex];
    if (selectedItem?.description) {
      lines.push("");
      const wrappedDesc = wrapTextWithAnsi(selectedItem.description, width - 4);
      for (const line of wrappedDesc) {
        lines.push(this.theme.description(`  ${line}`));
      }
    }
    this.addHintLine(lines, width);
    return lines;
  }
  handleInput(data) {
    if (this.submenuComponent) {
      this.submenuComponent.handleInput?.(data);
      return;
    }
    const kb = getKeybindings();
    const displayItems = this.searchEnabled ? this.filteredItems : this.items;
    if (kb.matches(data, "tui.select.up")) {
      if (displayItems.length === 0)
        return;
      this.selectedIndex = this.selectedIndex === 0 ? displayItems.length - 1 : this.selectedIndex - 1;
    } else if (kb.matches(data, "tui.select.down")) {
      if (displayItems.length === 0)
        return;
      this.selectedIndex = this.selectedIndex === displayItems.length - 1 ? 0 : this.selectedIndex + 1;
    } else if (kb.matches(data, "tui.select.confirm") || data === " " && (!this.searchEnabled || this.searchInput?.getValue().length === 0)) {
      this.activateItem();
    } else if (kb.matches(data, "tui.select.cancel")) {
      this.onCancel();
    } else if (this.searchEnabled && this.searchInput) {
      this.searchInput.handleInput(data);
      this.applyFilter(this.searchInput.getValue());
    }
  }
  activateItem() {
    const item = this.searchEnabled ? this.filteredItems[this.selectedIndex] : this.items[this.selectedIndex];
    if (!item)
      return;
    if (item.submenu) {
      this.submenuItemIndex = this.selectedIndex;
      this.submenuComponent = item.submenu(item.currentValue, (selectedValue, options) => {
        if (selectedValue !== void 0) {
          item.currentValue = selectedValue;
          this.onChange(item.id, selectedValue);
        }
        if (options?.navigateTo) {
          this.navigateAfterClose = options.navigateTo;
        }
        this.closeSubmenu();
      });
    } else if (item.values && item.values.length > 0) {
      const currentIndex = item.values.indexOf(item.currentValue);
      const nextIndex = (currentIndex + 1) % item.values.length;
      const newValue = item.values[nextIndex];
      item.currentValue = newValue;
      this.onChange(item.id, newValue);
    }
  }
  closeSubmenu() {
    this.submenuComponent = null;
    if (this.navigateAfterClose !== null) {
      const id = this.navigateAfterClose;
      this.navigateAfterClose = null;
      this.submenuItemIndex = null;
      this.selectItem(id);
      this.activateItem();
    } else if (this.submenuItemIndex !== null) {
      this.selectedIndex = this.submenuItemIndex;
      this.submenuItemIndex = null;
    }
  }
  applyFilter(query) {
    this.filteredItems = fuzzyFilter(this.items, query, (item) => item.label);
    this.selectedIndex = 0;
  }
  addHintLine(lines, width) {
    lines.push("");
    lines.push(truncateToWidth(this.theme.hint(this.searchEnabled ? "  Type to search \xB7 Enter/Space to change \xB7 Esc to cancel" : "  Enter/Space to change \xB7 Esc to cancel"), width));
  }
};

// node_modules/@earendil-works/pi-tui/dist/components/truncated-text.js
var TruncatedText = class {
  text;
  paddingX;
  paddingY;
  constructor(text, paddingX = 0, paddingY = 0) {
    this.text = text;
    this.paddingX = paddingX;
    this.paddingY = paddingY;
  }
  invalidate() {
  }
  render(width) {
    const result = [];
    const emptyLine = " ".repeat(width);
    for (let i = 0; i < this.paddingY; i++) {
      result.push(emptyLine);
    }
    const availableWidth = Math.max(1, width - this.paddingX * 2);
    let singleLineText = this.text;
    const newlineIndex = this.text.indexOf("\n");
    if (newlineIndex !== -1) {
      singleLineText = this.text.substring(0, newlineIndex);
    }
    const displayText = truncateToWidth(singleLineText, availableWidth);
    const leftPadding = " ".repeat(this.paddingX);
    const rightPadding = " ".repeat(this.paddingX);
    const lineWithPadding = leftPadding + displayText + rightPadding;
    const lineVisibleWidth = visibleWidth(lineWithPadding);
    const paddingNeeded = Math.max(0, width - lineVisibleWidth);
    const finalLine = lineWithPadding + " ".repeat(paddingNeeded);
    result.push(finalLine);
    for (let i = 0; i < this.paddingY; i++) {
      result.push(emptyLine);
    }
    return result;
  }
};

// node_modules/@earendil-works/pi-tui/dist/components/v-stack.js
var VStack = class extends Stack {
  layoutType = "vstack";
  constructor(children = [], options = {}) {
    super(children, options);
  }
  render(width) {
    const viewport = { width: Math.max(1, width), height: Number.MAX_SAFE_INTEGER };
    const entries = visibleStackEntries(this.entries, viewport);
    const rendered = entries.map((entry) => entry.component.render(viewport.width));
    const sizes = allocateStackSizes(entries, rendered.map((lines2) => lines2.length), void 0, this.gap);
    const lines = [];
    for (let index = 0; index < entries.length; index++) {
      if (index > 0) {
        for (let gap = 0; gap < this.gap; gap++)
          lines.push("");
      }
      const childLines = rendered[index].slice(0, sizes[index]);
      lines.push(...childLines);
      for (let padding = childLines.length; padding < sizes[index]; padding++)
        lines.push("");
    }
    return lines;
  }
};

// node_modules/@earendil-works/pi-tui/dist/stdin-buffer.js
import { EventEmitter as EventEmitter2 } from "events";
var ESC = "\x1B";
var DEFAULT_SEQUENCE_TIMEOUT_MS = 50;
var DEFAULT_ESCAPE_TIMEOUT_MS = 10;
var BRACKETED_PASTE_START = "\x1B[200~";
var BRACKETED_PASTE_END = "\x1B[201~";
function isCompleteSequence(data) {
  if (!data.startsWith(ESC)) {
    return "not-escape";
  }
  if (data.length === 1) {
    return "incomplete";
  }
  const afterEsc = data.slice(1);
  if (afterEsc.startsWith("[")) {
    if (afterEsc.startsWith("[M")) {
      return data.length >= 6 ? "complete" : "incomplete";
    }
    return isCompleteCsiSequence(data);
  }
  if (afterEsc.startsWith("]")) {
    return isCompleteOscSequence(data);
  }
  if (afterEsc.startsWith("P")) {
    return isCompleteDcsSequence(data);
  }
  if (afterEsc.startsWith("_")) {
    return isCompleteApcSequence(data);
  }
  if (afterEsc.startsWith("O")) {
    return afterEsc.length >= 2 ? "complete" : "incomplete";
  }
  if (afterEsc.length === 1) {
    return "complete";
  }
  return "complete";
}
function isCompleteCsiSequence(data) {
  if (!data.startsWith(`${ESC}[`)) {
    return "complete";
  }
  if (data.length < 3) {
    return "incomplete";
  }
  const payload = data.slice(2);
  const lastChar = payload[payload.length - 1];
  const lastCharCode = lastChar.charCodeAt(0);
  if (lastCharCode >= 64 && lastCharCode <= 126) {
    if (payload.startsWith("<")) {
      const mouseMatch = /^<\d+;\d+;\d+[Mm]$/.test(payload);
      if (mouseMatch) {
        return "complete";
      }
      if (lastChar === "M" || lastChar === "m") {
        const parts = payload.slice(1, -1).split(";");
        if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
          return "complete";
        }
      }
      return "incomplete";
    }
    return "complete";
  }
  return "incomplete";
}
function isCompleteOscSequence(data) {
  if (!data.startsWith(`${ESC}]`)) {
    return "complete";
  }
  if (data.endsWith(`${ESC}\\`) || data.endsWith("\x07")) {
    return "complete";
  }
  return "incomplete";
}
function isCompleteDcsSequence(data) {
  if (!data.startsWith(`${ESC}P`)) {
    return "complete";
  }
  if (data.endsWith(`${ESC}\\`)) {
    return "complete";
  }
  return "incomplete";
}
function isCompleteApcSequence(data) {
  if (!data.startsWith(`${ESC}_`)) {
    return "complete";
  }
  if (data.endsWith(`${ESC}\\`)) {
    return "complete";
  }
  return "incomplete";
}
function parseUnmodifiedKittyPrintableCodepoint(sequence) {
  const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
  if (!match)
    return void 0;
  const codepoint = parseInt(match[1], 10);
  return codepoint >= 32 ? codepoint : void 0;
}
function extractCompleteSequences(buffer) {
  const sequences = [];
  let pos = 0;
  while (pos < buffer.length) {
    const remaining = buffer.slice(pos);
    if (remaining.startsWith(ESC)) {
      let seqEnd = 1;
      while (seqEnd <= remaining.length) {
        const candidate = remaining.slice(0, seqEnd);
        const status = isCompleteSequence(candidate);
        if (status === "complete") {
          if (candidate === "\x1B\x1B") {
            const nextChar = remaining[seqEnd];
            if (nextChar === "[" || // CSI
            nextChar === "]" || // OSC
            nextChar === "O" || // SS3
            nextChar === "P" || // DCS
            nextChar === "_") {
              sequences.push(ESC);
              pos += 1;
              break;
            }
          }
          sequences.push(candidate);
          pos += seqEnd;
          break;
        } else if (status === "incomplete") {
          seqEnd++;
        } else {
          sequences.push(candidate);
          pos += seqEnd;
          break;
        }
      }
      if (seqEnd > remaining.length) {
        return { sequences, remainder: remaining };
      }
    } else {
      sequences.push(remaining[0]);
      pos++;
    }
  }
  return { sequences, remainder: "" };
}
var StdinBuffer = class extends EventEmitter2 {
  buffer = "";
  timeout = null;
  timeoutMs;
  escapeTimeoutMs;
  pasteMode = false;
  pasteBuffer = "";
  pendingKittyPrintableCodepoint;
  constructor(options = {}) {
    super();
    this.timeoutMs = options.timeout ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
    this.escapeTimeoutMs = options.escapeTimeout ?? DEFAULT_ESCAPE_TIMEOUT_MS;
  }
  process(data) {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    let str;
    if (Buffer.isBuffer(data)) {
      if (data.length === 1 && data[0] > 127) {
        const byte = data[0] - 128;
        str = `\x1B${String.fromCharCode(byte)}`;
      } else {
        str = data.toString();
      }
    } else {
      str = data;
    }
    if (str.length === 0 && this.buffer.length === 0) {
      this.emitDataSequence("");
      return;
    }
    this.buffer += str;
    if (this.pasteMode) {
      this.pasteBuffer += this.buffer;
      this.buffer = "";
      const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
      if (endIndex !== -1) {
        const pastedContent = this.pasteBuffer.slice(0, endIndex);
        const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);
        this.pasteMode = false;
        this.pasteBuffer = "";
        this.pendingKittyPrintableCodepoint = void 0;
        this.emit("paste", pastedContent);
        if (remaining.length > 0) {
          this.process(remaining);
        }
      }
      return;
    }
    const startIndex = this.buffer.indexOf(BRACKETED_PASTE_START);
    if (startIndex !== -1) {
      if (startIndex > 0) {
        const beforePaste = this.buffer.slice(0, startIndex);
        const result2 = extractCompleteSequences(beforePaste);
        for (const sequence of result2.sequences) {
          this.emitDataSequence(sequence);
        }
      }
      this.pendingKittyPrintableCodepoint = void 0;
      this.buffer = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
      this.pasteMode = true;
      this.pasteBuffer = this.buffer;
      this.buffer = "";
      const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
      if (endIndex !== -1) {
        const pastedContent = this.pasteBuffer.slice(0, endIndex);
        const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);
        this.pasteMode = false;
        this.pasteBuffer = "";
        this.pendingKittyPrintableCodepoint = void 0;
        this.emit("paste", pastedContent);
        if (remaining.length > 0) {
          this.process(remaining);
        }
      }
      return;
    }
    const result = extractCompleteSequences(this.buffer);
    this.buffer = result.remainder;
    for (const sequence of result.sequences) {
      this.emitDataSequence(sequence);
    }
    if (this.buffer.length > 0) {
      const timeoutMs = this.buffer === ESC ? this.escapeTimeoutMs : this.timeoutMs;
      this.timeout = setTimeout(() => {
        const flushed = this.flush();
        for (const sequence of flushed) {
          this.emitDataSequence(sequence);
        }
      }, timeoutMs);
    }
  }
  emitDataSequence(sequence) {
    const rawCodepoint = sequence.length === 1 ? sequence.codePointAt(0) : void 0;
    if (rawCodepoint !== void 0 && rawCodepoint === this.pendingKittyPrintableCodepoint) {
      this.pendingKittyPrintableCodepoint = void 0;
      return;
    }
    this.pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
    this.emit("data", sequence);
  }
  flush() {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    if (this.buffer.length === 0) {
      return [];
    }
    const sequences = [this.buffer];
    this.buffer = "";
    this.pendingKittyPrintableCodepoint = void 0;
    return sequences;
  }
  clear() {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    this.buffer = "";
    this.pasteMode = false;
    this.pasteBuffer = "";
    this.pendingKittyPrintableCodepoint = void 0;
  }
  getBuffer() {
    return this.buffer;
  }
  destroy() {
    this.clear();
  }
};

// node_modules/@earendil-works/pi-tui/dist/terminal.js
import * as fs2 from "node:fs";
import { createRequire as createRequire3 } from "node:module";
import * as path4 from "node:path";

// node_modules/@earendil-works/pi-tui/dist/native-modifiers.js
import { createRequire as createRequire2 } from "node:module";
import * as path3 from "node:path";

// node_modules/@earendil-works/pi-tui/dist/native-module-path.js
import { createRequire } from "node:module";
import { dirname as dirname2, join as join5 } from "node:path";
import { fileURLToPath } from "node:url";
var moduleRequire = createRequire(import.meta.url);
var TUI_PACKAGE_NAME = "@earendil-works/pi-tui";
function getNativeModuleCandidates(nativePath, options = {}) {
  const moduleDir = dirname2(fileURLToPath(options.moduleUrl ?? import.meta.url));
  const candidates = [];
  try {
    const packageEntry = (options.resolvePackage ?? moduleRequire.resolve)(TUI_PACKAGE_NAME);
    candidates.push(join5(dirname2(packageEntry), "..", nativePath));
  } catch {
  }
  candidates.push(join5(moduleDir, "..", nativePath), join5(moduleDir, nativePath), join5(dirname2(options.execPath ?? process.execPath), nativePath));
  return Array.from(new Set(candidates));
}

// node_modules/@earendil-works/pi-tui/dist/native-modifiers.js
var cjsRequire = createRequire2(import.meta.url);
var nativeModifiersHelper;
function isNativeModifiersHelper(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const candidate = value.isModifierPressed;
  return typeof candidate === "function";
}
function loadNativeModifiersHelper() {
  if (nativeModifiersHelper !== void 0)
    return nativeModifiersHelper ?? void 0;
  nativeModifiersHelper = null;
  const arch = process.arch;
  if (arch !== "x64" && arch !== "arm64")
    return void 0;
  let nativePath;
  if (process.platform === "darwin") {
    nativePath = path3.join("native", "darwin", "prebuilds", `darwin-${arch}`, "darwin-modifiers.node");
  } else if (process.platform === "win32") {
    nativePath = path3.join("native", "win32", "prebuilds", `win32-${arch}`, "win32-console-mode.node");
  } else {
    return void 0;
  }
  for (const modulePath of getNativeModuleCandidates(nativePath)) {
    try {
      const helper = cjsRequire(modulePath);
      if (isNativeModifiersHelper(helper)) {
        nativeModifiersHelper = helper;
        return helper;
      }
    } catch {
    }
  }
  return void 0;
}
function isNativeModifierPressed(key) {
  const helper = loadNativeModifiersHelper();
  if (!helper)
    return false;
  try {
    return helper.isModifierPressed(key) === true;
  } catch {
    return false;
  }
}

// node_modules/@earendil-works/pi-tui/dist/terminal.js
var cjsRequire2 = createRequire3(import.meta.url);
var TERMINAL_PROGRESS_KEEPALIVE_MS = 1e3;
var TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1B]9;4;3\x07";
var TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1B]9;4;0\x07";
var NATIVE_SHIFT_ENTER_SEQUENCE = "\x1B[13;2u";
var DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS = 7;
var KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS = 150;
var KITTY_KEYBOARD_PROTOCOL_QUERY = `\x1B[>${DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS}u\x1B[?u\x1B[c`;
function parseKeyboardProtocolNegotiationSequence(sequence) {
  const kittyFlags = sequence.match(/^\x1b\[\?(\d+)u$/);
  if (kittyFlags) {
    return { type: "kitty-flags", flags: Number.parseInt(kittyFlags[1], 10) };
  }
  if (/^\x1b\[\?[\d;]*c$/.test(sequence)) {
    return { type: "device-attributes" };
  }
  return void 0;
}
function isKeyboardProtocolNegotiationSequencePrefix(sequence) {
  return sequence === "\x1B[" || /^\x1b\[\?[\d;]*$/.test(sequence);
}
function isAppleTerminalSession() {
  return process.platform === "darwin" && process.env.TERM_PROGRAM === "Apple_Terminal";
}
function normalizeNativeShiftEnterInput(data, shouldDetectNativeShiftEnter, isShiftPressed) {
  if (shouldDetectNativeShiftEnter && data === "\r" && isShiftPressed)
    return NATIVE_SHIFT_ENTER_SEQUENCE;
  return data;
}
var DEFAULT_ESCAPE_TIMEOUT_MS2 = 10;
var DEFAULT_SSH_ESCAPE_TIMEOUT_MS = 100;
function resolveEscapeTimeoutMs(env = process.env) {
  const configured = Number(env.PI_TUI_ESC_TIMEOUT);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  if (env.SSH_CONNECTION || env.SSH_TTY) {
    return DEFAULT_SSH_ESCAPE_TIMEOUT_MS;
  }
  return DEFAULT_ESCAPE_TIMEOUT_MS2;
}
var ProcessTerminal = class {
  wasRaw = false;
  inputHandler;
  resizeHandler;
  _kittyProtocolActive = false;
  _modifyOtherKeysActive = false;
  keyboardProtocolPushed = false;
  keyboardProtocolNegotiationBuffer = "";
  keyboardProtocolBufferFlushTimer;
  stdinBuffer;
  stdinDataHandler;
  progressInterval;
  writeLogPath = (() => {
    const env = process.env.PI_TUI_WRITE_LOG || "";
    if (!env)
      return "";
    try {
      if (fs2.statSync(env).isDirectory()) {
        const now = /* @__PURE__ */ new Date();
        const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
        return path4.join(env, `tui-${ts}-${process.pid}.log`);
      }
    } catch {
    }
    return env;
  })();
  get kittyProtocolActive() {
    return this._kittyProtocolActive;
  }
  get modifyOtherKeysActive() {
    return this._modifyOtherKeysActive;
  }
  start(onInput, onResize) {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;
    this.wasRaw = process.stdin.isRaw || false;
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdout.write("\x1B[?2004h");
    process.stdout.on("resize", this.resizeHandler);
    if (process.platform !== "win32") {
      process.kill(process.pid, "SIGWINCH");
    }
    this.enableWindowsVTInput();
    this.queryAndEnableKittyProtocol();
  }
  /**
   * Set up StdinBuffer to split batched input into individual sequences.
   * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
   *
   * Also watches for Kitty protocol response and enables it when detected.
   * This is done here (after stdinBuffer parsing) rather than on raw stdin
   * to handle the case where the response arrives split across multiple events.
   */
  setupStdinBuffer() {
    this.stdinBuffer = new StdinBuffer({ escapeTimeout: resolveEscapeTimeoutMs() });
    this.stdinBuffer.on("data", (sequence) => {
      const negotiationSequence = this.readKeyboardProtocolNegotiationSequence(sequence);
      if (negotiationSequence === "pending") {
        this.scheduleKeyboardProtocolNegotiationBufferFlush();
        return;
      }
      if (this.handleKeyboardProtocolNegotiationSequence(negotiationSequence)) {
        return;
      }
      this.forwardInputSequence(sequence);
    });
    this.stdinBuffer.on("paste", (content) => {
      if (this.inputHandler) {
        this.inputHandler(`\x1B[200~${content}\x1B[201~`);
      }
    });
    this.stdinDataHandler = (data) => {
      this.stdinBuffer.process(data);
    };
  }
  /**
   * Query terminal for Kitty keyboard protocol support and enable it if available.
   *
   * Kitty's progressive enhancement detection requires requesting the desired
   * flags before querying them. The trailing DA query is a sentinel supported by
   * terminals that do not know Kitty keyboard protocol; receiving DA before a
   * Kitty response enables modifyOtherKeys fallback without a startup timeout.
   *
   * The requested flags are:
   * - 1 = disambiguate escape codes
   * - 2 = report event types (press/repeat/release)
   * - 4 = report alternate keys (shifted key, base layout key)
   */
  queryAndEnableKittyProtocol() {
    this.setupStdinBuffer();
    process.stdin.on("data", this.stdinDataHandler);
    this.keyboardProtocolPushed = true;
    this.clearKeyboardProtocolNegotiationBuffer();
    process.stdout.write(KITTY_KEYBOARD_PROTOCOL_QUERY);
  }
  handleKeyboardProtocolNegotiationSequence(negotiationSequence) {
    if (!negotiationSequence)
      return false;
    this.clearKeyboardProtocolNegotiationBuffer();
    if (negotiationSequence.type === "kitty-flags") {
      if (negotiationSequence.flags !== 0) {
        this.disableModifyOtherKeys();
        if (!this._kittyProtocolActive) {
          this._kittyProtocolActive = true;
          setKittyProtocolActive(true);
        }
      } else {
        this.enableModifyOtherKeys();
      }
      return true;
    }
    if (!this._kittyProtocolActive) {
      this.enableModifyOtherKeys();
    }
    return true;
  }
  readKeyboardProtocolNegotiationSequence(sequence) {
    if (this.keyboardProtocolNegotiationBuffer) {
      const bufferedSequence = this.keyboardProtocolNegotiationBuffer + sequence;
      const negotiationSequence2 = parseKeyboardProtocolNegotiationSequence(bufferedSequence);
      if (negotiationSequence2) {
        this.clearKeyboardProtocolNegotiationBuffer();
        return negotiationSequence2;
      }
      if (isKeyboardProtocolNegotiationSequencePrefix(bufferedSequence)) {
        this.setKeyboardProtocolNegotiationBuffer(bufferedSequence);
        return "pending";
      }
      this.flushKeyboardProtocolNegotiationBufferAsInput();
    }
    const negotiationSequence = parseKeyboardProtocolNegotiationSequence(sequence);
    if (negotiationSequence)
      return negotiationSequence;
    if (isKeyboardProtocolNegotiationSequencePrefix(sequence)) {
      this.setKeyboardProtocolNegotiationBuffer(sequence);
      return "pending";
    }
    return void 0;
  }
  setKeyboardProtocolNegotiationBuffer(sequence) {
    this.clearKeyboardProtocolNegotiationBufferFlushTimer();
    this.keyboardProtocolNegotiationBuffer = sequence;
  }
  clearKeyboardProtocolNegotiationBuffer() {
    this.clearKeyboardProtocolNegotiationBufferFlushTimer();
    this.keyboardProtocolNegotiationBuffer = "";
  }
  flushKeyboardProtocolNegotiationBufferAsInput() {
    if (!this.keyboardProtocolNegotiationBuffer)
      return;
    const sequence = this.keyboardProtocolNegotiationBuffer;
    this.clearKeyboardProtocolNegotiationBuffer();
    this.forwardInputSequence(sequence);
  }
  scheduleKeyboardProtocolNegotiationBufferFlush() {
    if (!this.keyboardProtocolNegotiationBuffer || this.keyboardProtocolBufferFlushTimer)
      return;
    this.keyboardProtocolBufferFlushTimer = setTimeout(() => {
      this.keyboardProtocolBufferFlushTimer = void 0;
      this.flushKeyboardProtocolNegotiationBufferAsInput();
    }, KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS);
  }
  clearKeyboardProtocolNegotiationBufferFlushTimer() {
    if (!this.keyboardProtocolBufferFlushTimer)
      return;
    clearTimeout(this.keyboardProtocolBufferFlushTimer);
    this.keyboardProtocolBufferFlushTimer = void 0;
  }
  forwardInputSequence(sequence) {
    if (!this.inputHandler)
      return;
    const shouldDetectNativeShiftEnter = sequence === "\r" && (isAppleTerminalSession() || process.platform === "win32");
    const input = normalizeNativeShiftEnterInput(sequence, shouldDetectNativeShiftEnter, shouldDetectNativeShiftEnter && isNativeModifierPressed("shift"));
    this.inputHandler(input);
  }
  enableModifyOtherKeys() {
    if (this._kittyProtocolActive || this._modifyOtherKeysActive)
      return;
    process.stdout.write("\x1B[>4;2m");
    this._modifyOtherKeysActive = true;
  }
  disableModifyOtherKeys() {
    if (!this._modifyOtherKeysActive)
      return;
    process.stdout.write("\x1B[>4;0m");
    this._modifyOtherKeysActive = false;
  }
  /**
   * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT (0x0200) to the stdin
   * console handle so the terminal sends VT sequences for modified keys
   * (e.g. \x1b[Z for Shift+Tab). Without this, libuv's ReadConsoleInputW
   * discards modifier state and Shift+Tab arrives as plain \t.
   */
  enableWindowsVTInput() {
    if (process.platform !== "win32")
      return;
    try {
      const arch = process.arch;
      if (arch !== "x64" && arch !== "arm64")
        return;
      const nativePath = path4.join("native", "win32", "prebuilds", `win32-${arch}`, "win32-console-mode.node");
      for (const modulePath of getNativeModuleCandidates(nativePath)) {
        try {
          const helper = cjsRequire2(modulePath);
          helper.enableVirtualTerminalInput?.();
          return;
        } catch {
        }
      }
    } catch {
    }
  }
  async drainInput(maxMs = 1e3, idleMs = 50) {
    const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
    this.clearKeyboardProtocolNegotiationBuffer();
    if (shouldDisableKittyProtocol) {
      process.stdout.write("\x1B[<u");
      this.keyboardProtocolPushed = false;
      this._kittyProtocolActive = false;
      setKittyProtocolActive(false);
    }
    this.disableModifyOtherKeys();
    const previousHandler = this.inputHandler;
    this.inputHandler = void 0;
    let lastDataTime = Date.now();
    const onData = () => {
      lastDataTime = Date.now();
    };
    process.stdin.on("data", onData);
    const endTime = Date.now() + maxMs;
    try {
      while (true) {
        const now = Date.now();
        const timeLeft = endTime - now;
        if (timeLeft <= 0)
          break;
        if (now - lastDataTime >= idleMs)
          break;
        await new Promise((resolve4) => setTimeout(resolve4, Math.min(idleMs, timeLeft)));
      }
    } finally {
      process.stdin.removeListener("data", onData);
      this.inputHandler = previousHandler;
    }
  }
  stop() {
    if (this.clearProgressInterval()) {
      process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
    }
    process.stdout.write("\x1B[?2004l");
    const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
    this.clearKeyboardProtocolNegotiationBuffer();
    if (shouldDisableKittyProtocol) {
      process.stdout.write("\x1B[<u");
      this.keyboardProtocolPushed = false;
      this._kittyProtocolActive = false;
      setKittyProtocolActive(false);
    }
    this.disableModifyOtherKeys();
    if (this.stdinBuffer) {
      this.stdinBuffer.destroy();
      this.stdinBuffer = void 0;
    }
    if (this.stdinDataHandler) {
      process.stdin.removeListener("data", this.stdinDataHandler);
      this.stdinDataHandler = void 0;
    }
    this.inputHandler = void 0;
    if (this.resizeHandler) {
      process.stdout.removeListener("resize", this.resizeHandler);
      this.resizeHandler = void 0;
    }
    process.stdin.pause();
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(this.wasRaw);
    }
  }
  write(data) {
    process.stdout.write(data);
    if (this.writeLogPath) {
      try {
        fs2.appendFileSync(this.writeLogPath, data, { encoding: "utf8" });
      } catch {
      }
    }
  }
  get columns() {
    return process.stdout.columns || Number(process.env.COLUMNS) || 80;
  }
  get rows() {
    return process.stdout.rows || Number(process.env.LINES) || 24;
  }
  moveBy(lines) {
    if (lines > 0) {
      process.stdout.write(`\x1B[${lines}B`);
    } else if (lines < 0) {
      process.stdout.write(`\x1B[${-lines}A`);
    }
  }
  hideCursor() {
    process.stdout.write("\x1B[?25l");
  }
  showCursor() {
    process.stdout.write("\x1B[?25h");
  }
  clearLine() {
    process.stdout.write("\x1B[K");
  }
  clearFromCursor() {
    process.stdout.write("\x1B[J");
  }
  clearScreen() {
    process.stdout.write("\x1B[2J\x1B[H");
  }
  setTitle(title) {
    process.stdout.write(`\x1B]0;${title}\x07`);
  }
  setProgress(active) {
    if (active) {
      process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
      if (!this.progressInterval) {
        this.progressInterval = setInterval(() => {
          process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
        }, TERMINAL_PROGRESS_KEEPALIVE_MS);
      }
    } else {
      this.clearProgressInterval();
      process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
    }
  }
  clearProgressInterval() {
    if (!this.progressInterval)
      return false;
    clearInterval(this.progressInterval);
    this.progressInterval = void 0;
    return true;
  }
};

// node_modules/@earendil-works/pi-tui/dist/alt-screen-search.js
var segmenter2 = getGraphemeSegmenter();
function appendMappedText(text, span, corpus) {
  corpus.text += text;
  for (let index = 0; index < text.length; index++)
    corpus.source.push(span);
}
function buildSearchCorpus(lines) {
  const corpus = { text: "", source: [] };
  let pendingSeparator = false;
  for (let row = 0; row < lines.length; row++) {
    const line = stripTerminalSequences(lines[row] ?? "");
    let column = 0;
    for (const grapheme of segmenter2.segment(line)) {
      const text = grapheme.segment;
      const width = visibleWidth(text);
      if (/^\s+$/u.test(text)) {
        if (corpus.text.length > 0)
          pendingSeparator = true;
        column += width;
        continue;
      }
      if (pendingSeparator) {
        appendMappedText(" ", void 0, corpus);
        pendingSeparator = false;
      }
      appendMappedText(text, { row, startCol: column, endCol: column + width }, corpus);
      column += width;
    }
    if (corpus.text.length > 0)
      pendingSeparator = true;
  }
  return corpus;
}
function normalizeQuery(query) {
  return query.replace(/\s+/gu, " ").trim();
}
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function findAltScreenSearchMatches(lines, query) {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery)
    return [];
  const corpus = buildSearchCorpus(lines);
  const expression = new RegExp(escapeRegExp(normalizedQuery), "giu");
  const matches = [];
  for (const match of corpus.text.matchAll(expression)) {
    const start = match.index;
    const end = start + match[0].length;
    const segments = [];
    for (let index = start; index < end; index++) {
      const span = corpus.source[index];
      if (!span)
        continue;
      const previous = segments[segments.length - 1];
      if (previous && previous.row === span.row && span.startCol <= previous.endCol) {
        previous.endCol = Math.max(previous.endCol, span.endCol);
      } else {
        segments.push({ ...span });
      }
    }
    if (segments.length > 0)
      matches.push({ segments });
  }
  return matches;
}
function getAltScreenSearchMatchKey(match) {
  const first = match.segments[0];
  const last = match.segments[match.segments.length - 1];
  return first && last ? `${first.row}:${first.startCol}:${last.row}:${last.endCol}` : "";
}
var AltScreenSearchComponent = class {
  input = new Input();
  onQueryChange;
  resultCount = 0;
  resultIndex = -1;
  _focused = false;
  constructor(onQueryChange) {
    this.onQueryChange = onQueryChange;
  }
  get focused() {
    return this._focused;
  }
  set focused(value) {
    this._focused = value;
    this.input.focused = value;
  }
  setResult(index, count) {
    this.resultIndex = index;
    this.resultCount = count;
  }
  handleInput(data) {
    const previous = this.input.getValue();
    this.input.handleInput(data);
    const query = this.input.getValue();
    if (query !== previous)
      this.onQueryChange(query);
  }
  invalidate() {
    this.input.invalidate();
  }
  render(width) {
    const safeWidth = Math.max(1, width);
    const label = " Find transcript";
    const query = this.input.getValue();
    const status = !query ? "" : this.resultCount === 0 ? "No matches " : `${this.resultIndex + 1}/${this.resultCount} `;
    const labelWidth = visibleWidth(label);
    const statusWidth = visibleWidth(status);
    const gap = " ".repeat(Math.max(1, safeWidth - labelWidth - statusWidth));
    const title = truncateToWidth(`${label}${gap}${status}`, safeWidth, "");
    const padding = " ".repeat(Math.max(0, safeWidth - visibleWidth(title)));
    return [`\x1B[7m${title}${padding}\x1B[27m`, ...this.input.render(safeWidth)];
  }
};

// node_modules/@earendil-works/pi-tui/dist/components/alt-screen-flash.js
var DEFAULT_DURATION_MS = 1e3;
var AltScreenFlashContainer = class {
  entries = [];
  nextId = 0;
  requestRender;
  constructor(requestRender) {
    this.requestRender = requestRender;
  }
  flash(message, durationMs2 = DEFAULT_DURATION_MS) {
    const id = this.nextId++;
    const timer = setTimeout(() => {
      const index = this.entries.findIndex((entry) => entry.id === id);
      if (index === -1)
        return;
      this.entries.splice(index, 1);
      this.requestRender();
    }, Math.max(0, durationMs2));
    timer.unref();
    this.entries.push({ id, message, timer });
    this.requestRender();
  }
  dispose() {
    for (const entry of this.entries)
      clearTimeout(entry.timer);
    this.entries.length = 0;
  }
  invalidate() {
  }
  render(width) {
    return this.entries.map((entry) => {
      const message = truncateToWidth(` ${entry.message} `, width, "");
      return `\x1B[7m${message}\x1B[27m`;
    });
  }
};

// node_modules/@earendil-works/pi-tui/dist/layout.js
var OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
function intersect(a, b2) {
  const x2 = Math.max(a.x, b2.x);
  const y2 = Math.max(a.y, b2.y);
  const right = Math.min(a.x + a.width, b2.x + b2.width);
  const bottom = Math.min(a.y + a.height, b2.y + b2.height);
  return { x: x2, y: y2, width: Math.max(0, right - x2), height: Math.max(0, bottom - y2) };
}
function renderCached(context, component, width) {
  const safeWidth = Math.max(1, Math.floor(width));
  let widths = context.renderCache.get(component);
  if (!widths) {
    widths = /* @__PURE__ */ new Map();
    context.renderCache.set(component, widths);
  }
  let lines = widths.get(safeWidth);
  if (!lines) {
    lines = component.render(safeWidth);
    widths.set(safeWidth, lines);
  }
  return lines;
}
function measureHeight(context, component, width) {
  return renderCached(context, component, width).length;
}
function measureWidth(context, component, width) {
  return renderCached(context, component, width).reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}
function withParent(box, parent) {
  box.parent = parent;
  return box;
}
function translateBox(box, deltaY) {
  box.rect.y += deltaY;
  for (const child of box.children)
    translateBox(child, deltaY);
}
function updateClips(box, parentClip) {
  box.clip = intersect(parentClip, box.rect);
  for (const child of box.children)
    updateClips(child, box.clip);
}
function layoutComponent(context, component, x2, y2, width, height, clip) {
  const safeWidth = Math.max(1, Math.floor(width));
  const node = getLayoutNode(component);
  if (!node) {
    const lines = renderCached(context, component, safeWidth);
    const allocatedHeight2 = height === void 0 ? lines.length : Math.max(0, Math.floor(height));
    let lineOffset = 0;
    if (lines.length > allocatedHeight2 && allocatedHeight2 > 0) {
      const cursorLine = lines.findIndex((line) => line.includes(CURSOR_MARKER));
      if (cursorLine >= allocatedHeight2)
        lineOffset = cursorLine - allocatedHeight2 + 1;
    }
    return {
      component,
      rect: { x: x2, y: y2, width: safeWidth, height: allocatedHeight2 },
      clip: intersect(clip, { x: x2, y: y2, width: safeWidth, height: allocatedHeight2 }),
      children: [],
      lines,
      lineOffset,
      layer: 0
    };
  }
  if (node.type === "scroll") {
    const previousScrollTop = node.state.scrollTop;
    const contentWidth = node.state.getContentWidth(safeWidth);
    const childBox = layoutComponent(context, node.component, x2, y2 - previousScrollTop, contentWidth, void 0, clip);
    const contentHeight = childBox.rect.height;
    const viewportHeight = height === void 0 ? contentHeight : Math.max(0, Math.floor(height));
    node.state.updateLayout(contentHeight, viewportHeight, context.requestRender);
    translateBox(childBox, previousScrollTop - node.state.scrollTop);
    const scrollView = node.state;
    if (node.state.primary || !context.primaryScrollView)
      context.primaryScrollView = scrollView;
    const rect2 = { x: x2, y: y2, width: safeWidth, height: viewportHeight };
    const childClip = intersect(clip, rect2);
    const box2 = {
      component,
      rect: rect2,
      clip: childClip,
      children: [childBox],
      scrollView,
      scrollContentLines: renderCached(context, node.component, contentWidth),
      layer: 0
    };
    childBox.parent = box2;
    updateClips(childBox, childClip);
    return box2;
  }
  const entries = visibleStackEntries(node.entries, context.viewport);
  const gapTotal = Math.max(0, entries.length - 1) * node.gap;
  if (node.type === "vstack") {
    const intrinsicHeights2 = entries.map((entry) => typeof entry.basis === "number" ? entry.basis : measureHeight(context, entry.component, safeWidth));
    const sizes = allocateStackSizes(entries, intrinsicHeights2, height, node.gap);
    const naturalHeight = sizes.reduce((sum, size) => sum + size, 0) + gapTotal;
    const allocatedHeight2 = height === void 0 ? naturalHeight : Math.max(0, Math.floor(height));
    const rect2 = { x: x2, y: y2, width: safeWidth, height: allocatedHeight2 };
    const box2 = {
      component,
      rect: rect2,
      clip: intersect(clip, rect2),
      children: [],
      layer: 0
    };
    let childY = y2;
    for (let index = 0; index < entries.length; index++) {
      box2.children.push(withParent(layoutComponent(context, entries[index].component, x2, childY, safeWidth, sizes[index], box2.clip), box2));
      childY += sizes[index] + node.gap;
    }
    return box2;
  }
  const intrinsicWidths = entries.map((entry) => typeof entry.basis === "number" ? entry.basis : measureWidth(context, entry.component, safeWidth));
  const widths = allocateStackSizes(entries, intrinsicWidths, safeWidth, node.gap);
  const intrinsicHeights = entries.map((entry, index) => measureHeight(context, entry.component, Math.max(1, widths[index])));
  const allocatedHeight = height === void 0 ? intrinsicHeights.reduce((max, childHeight) => Math.max(max, childHeight), 0) : Math.max(0, height);
  const rect = { x: x2, y: y2, width: safeWidth, height: allocatedHeight };
  const box = {
    component,
    rect,
    clip: intersect(clip, rect),
    children: [],
    layer: 0
  };
  let childX = x2;
  for (let index = 0; index < entries.length; index++) {
    const naturalChildHeight = intrinsicHeights[index];
    const childHeight = node.align === "stretch" ? allocatedHeight : Math.min(allocatedHeight, naturalChildHeight);
    let childY = y2;
    if (node.align === "center")
      childY += Math.floor((allocatedHeight - childHeight) / 2);
    else if (node.align === "end")
      childY += allocatedHeight - childHeight;
    const childWidth = widths[index];
    if (childWidth === 0) {
      box.children.push({
        component: entries[index].component,
        rect: { x: childX, y: childY, width: 0, height: childHeight },
        clip: { x: childX, y: childY, width: 0, height: 0 },
        children: [],
        parent: box,
        layer: 0
      });
    } else {
      box.children.push(withParent(layoutComponent(context, entries[index].component, childX, childY, childWidth, childHeight, box.clip), box));
    }
    childX += childWidth + node.gap;
  }
  return box;
}
function styleScrollbarCell(line, column, totalWidth, style) {
  if (isImageLine(line))
    return line;
  const graphemeRange = getGraphemeCellRange(line, column);
  const start = graphemeRange?.start ?? column;
  const end = graphemeRange?.end ?? column + 1;
  const before = sliceByColumn(line, 0, start, true);
  const target = sliceByColumn(line, start, end - start, true);
  const after = sliceByColumn(line, end, Math.max(0, totalWidth - end), true);
  let targetPrefix = "";
  let targetIndex = 0;
  while (targetIndex < target.length) {
    const ansi = extractAnsiCode(target, targetIndex);
    if (!ansi)
      break;
    targetPrefix += ansi.code;
    targetIndex += ansi.length;
  }
  const targetText = target.slice(targetIndex) || " ".repeat(end - start);
  const beforePadding = " ".repeat(Math.max(0, start - visibleWidth(before)));
  return `${before}${beforePadding}${targetPrefix}${style(targetText)}${after}`;
}
function getScrollbarGeometry(box) {
  if (!box.scrollView?.isScrollbarVisible || box.rect.width <= 0 || box.rect.height <= 0)
    return void 0;
  const contentHeight = box.children[0]?.rect.height ?? box.scrollContentLines?.length ?? 0;
  const trackHeight = box.rect.height;
  const minThumbHeight = Math.min(2, trackHeight);
  const thumbHeight = Math.max(minThumbHeight, Math.min(trackHeight, Math.round(trackHeight * trackHeight / contentHeight)));
  const maxScrollTop = Math.max(0, contentHeight - trackHeight);
  const maxThumbTop = trackHeight - thumbHeight;
  const thumbOffset = maxScrollTop === 0 ? 0 : Math.round(box.scrollView.scrollTop / maxScrollTop * maxThumbTop);
  const column = box.rect.x + box.rect.width - 1;
  if (column < box.clip.x || column >= box.clip.x + box.clip.width)
    return void 0;
  return {
    column,
    trackTop: box.rect.y,
    trackHeight,
    thumbTop: box.rect.y + thumbOffset,
    thumbHeight,
    maxScrollTop
  };
}
function paintScrollbar(box, screen, totalWidth) {
  const geometry = getScrollbarGeometry(box);
  if (!geometry || !box.scrollView)
    return;
  for (let offset = 0; offset < geometry.thumbHeight; offset++) {
    const row = geometry.thumbTop + offset;
    if (row < box.clip.y || row >= box.clip.y + box.clip.height || row < 0 || row >= screen.length)
      continue;
    screen[row] = styleScrollbarCell(screen[row] ?? "", geometry.column, totalWidth, box.scrollView.scrollbarStyle);
  }
}
function paintBox(box, screen, totalWidth) {
  if (box.lines) {
    const offset = box.lineOffset ?? 0;
    const firstRow = Math.max(box.rect.y, box.clip.y, 0);
    const lastRow = Math.min(box.rect.y + box.rect.height, box.clip.y + box.clip.height, screen.length);
    for (let row = firstRow; row < lastRow; row++) {
      const sourceLine = box.lines[offset + row - box.rect.y];
      if (sourceLine === void 0)
        continue;
      let line = sourceLine.replace(OSC133_ZONE_PREFIX, "");
      const imageMetadata = getKittyImageMetadata(line);
      if (imageMetadata) {
        const clipBottom = Math.min(screen.length, box.clip.y + box.clip.height);
        const visibleRows = Math.min(imageMetadata.rows, clipBottom - row);
        if (visibleRows < imageMetadata.rows)
          line = cropKittyImageLine(line, 0, visibleRows);
      }
      if (box.rect.x === 0 && box.rect.width >= totalWidth && (isImageLine(line) || !screen[row])) {
        screen[row] = line;
      } else {
        screen[row] = compositeTuiLine(screen[row] ?? "", line, box.rect.x, box.rect.width, totalWidth);
      }
    }
  }
  for (const child of box.children)
    paintBox(child, screen, totalWidth);
  if (box.scrollView && box.scrollContentLines && box.scrollView.scrollTop > 0 && box.rect.height > 0) {
    for (let imageRow = box.scrollView.scrollTop - 1; imageRow >= 0; imageRow--) {
      const imageLine = box.scrollContentLines[imageRow] ?? "";
      const metadata = getKittyImageMetadata(imageLine);
      if (metadata) {
        const hiddenRows = box.scrollView.scrollTop - imageRow;
        if (hiddenRows < metadata.rows) {
          const visibleRows = Math.min(box.rect.height, metadata.rows - hiddenRows);
          const cropped = cropKittyImageLine(imageLine, hiddenRows, visibleRows);
          if (box.rect.x === 0 && box.rect.width >= totalWidth)
            screen[box.rect.y] = cropped;
        }
        break;
      }
      if (imageLine !== "")
        break;
    }
  }
  paintScrollbar(box, screen, totalWidth);
}
function renderLayoutFrame(root, width, height, requestRender) {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const context = {
    viewport: { width: safeWidth, height: safeHeight },
    renderCache: /* @__PURE__ */ new Map(),
    requestRender,
    primaryScrollView: void 0
  };
  const rootBox = layoutComponent(context, root, 0, 0, safeWidth, safeHeight, {
    x: 0,
    y: 0,
    width: safeWidth,
    height: safeHeight
  });
  const lines = Array.from({ length: safeHeight }, () => "");
  paintBox(rootBox, lines, safeWidth);
  return {
    root: rootBox,
    width: safeWidth,
    height: safeHeight,
    lines,
    ...context.primaryScrollView === void 0 ? {} : { primaryScrollView: context.primaryScrollView }
  };
}
function containsPoint(rect, x2, y2) {
  return x2 >= rect.x && x2 < rect.x + rect.width && y2 >= rect.y && y2 < rect.y + rect.height;
}
function getScrollViewBox(frame, scrollView) {
  const visit = (box) => {
    if (box.scrollView === scrollView)
      return box;
    for (const child of box.children) {
      const match = visit(child);
      if (match)
        return match;
    }
    return void 0;
  };
  return visit(frame.root);
}
function getScrollViewsAt(frame, x2, y2) {
  const result = [];
  const visit = (box, depth) => {
    if (!containsPoint(box.clip, x2, y2))
      return;
    if (box.scrollView && containsPoint(box.rect, x2, y2))
      result.push({ scrollView: box.scrollView, depth });
    for (const child of box.children)
      visit(child, depth + 1);
  };
  visit(frame.root, 0);
  result.sort((a, b2) => b2.depth - a.depth);
  return result.map((entry) => entry.scrollView);
}

// node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js
var ENTER_ALT_SCREEN = "\x1B[?1049h";
var EXIT_ALT_SCREEN = "\x1B[?1049l";
var DISABLE_AUTOWRAP = "\x1B[?7l";
var ENABLE_AUTOWRAP = "\x1B[?7h";
var ENABLE_BUTTON_MOTION_MOUSE = "\x1B[?1000h\x1B[?1002h\x1B[?1004h\x1B[?1006h";
var ENABLE_ALL_MOTION_MOUSE = "\x1B[?1000h\x1B[?1002h\x1B[?1003h\x1B[?1004h\x1B[?1006h";
var DISABLE_MOUSE = "\x1B[?1006l\x1B[?1004l\x1B[?1003l\x1B[?1002l\x1B[?1000l";
var FOCUS_IN = "\x1B[I";
var FOCUS_OUT = "\x1B[O";
var BEGIN_SYNCHRONIZED_OUTPUT = "\x1B[?2026h";
var END_SYNCHRONIZED_OUTPUT = "\x1B[?2026l";
var OSC133_ZONE_PREFIX2 = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
var OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;
var PAGE_SCROLL_OVERLAP = 4;
var MAX_CACHED_OFFSCREEN_KITTY_IMAGES = 16;
var MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES = 32 * 1024 * 1024;
var MAX_CACHED_OFFSCREEN_KITTY_DECODED_BYTES = 64 * 1024 * 1024;
var DOUBLE_CLICK_INTERVAL_MS = 500;
var wordSegmenter4 = getWordSegmenter();
var TuiAltScreen = class extends TuiBase {
  mode = "fullscreen";
  [VIEWPORT_TUI] = true;
  previousScreen = [];
  lastDocument = [];
  previousScreenWidth = 0;
  previousScreenHeight = 0;
  layoutRoot;
  currentLayout;
  implicitDocument;
  implicitScrollView;
  flashes;
  altScreenActive = false;
  imageProtocol = null;
  savedCapabilities;
  uploadedKittyImages = /* @__PURE__ */ new Map();
  selectionAnchor;
  selectionFocus;
  selectionGranularity = "character";
  selectionInitialRange;
  lastClick;
  selectionDragPointer;
  selectionAutoScrollDirection = 0;
  selectionAutoScrollTimer;
  selectionPressActive = false;
  scrollbarDrag;
  scrollbarHover;
  activeSearch;
  pressedUrl;
  selectionDragged = false;
  wheelScrollLines;
  mouseEnabled;
  searchMatchStyle;
  searchCurrentMatchStyle;
  openUrl;
  onRightClickPaste;
  copySelection;
  constructor(terminal, showHardwareCursor, logDirectory, options = {}) {
    super(terminal, showHardwareCursor, logDirectory);
    this.implicitDocument = {
      render: (width) => super.render(width),
      invalidate: () => {
        for (const child of this.children)
          child.invalidate();
      }
    };
    this.implicitScrollView = new ScrollView(this.implicitDocument, { follow: "end", primary: true });
    this.flashes = new AltScreenFlashContainer(() => this.requestRender());
    this.wheelScrollLines = Math.max(1, Math.floor(options.wheelScrollLines ?? 1));
    this.mouseEnabled = options.mouse ?? true;
    this.searchMatchStyle = options.searchMatchStyle ?? ((text) => `\x1B[4m${text}\x1B[24m`);
    this.searchCurrentMatchStyle = options.searchCurrentMatchStyle ?? ((text) => `\x1B[1;7m${text}\x1B[22;27m`);
    this.openUrl = options.openUrl;
    this.onRightClickPaste = options.onRightClickPaste;
    this.copySelection = options.copySelection;
    this.addInputListener((data) => this.handleViewportInput(data));
  }
  get viewportTop() {
    return this.getPrimaryScrollView().scrollTop;
  }
  get isFollowingOutput() {
    return this.getPrimaryScrollView().isFollowingEnd;
  }
  setLayoutRoot(component) {
    if (this.layoutRoot === component)
      return;
    this.layoutRoot = component;
    this.currentLayout = void 0;
    this.requestRender();
  }
  render(width) {
    return this.layoutRoot?.render(width) ?? super.render(width);
  }
  getMountedRoots() {
    return this.layoutRoot ? [this.layoutRoot] : this.children;
  }
  getPrimaryScrollView() {
    return this.currentLayout?.primaryScrollView ?? this.implicitScrollView;
  }
  beforeTerminalStart() {
    this.stopSelectionAutoScroll();
    this.selectionPressActive = false;
    this.stopScrollbarHover();
    this.stopScrollbarDrag();
    this.flashes.dispose();
    this.altScreenActive = true;
    const capabilities = getCapabilities();
    this.imageProtocol = capabilities.images;
    this.uploadedKittyImages.clear();
    if (capabilities.images === "iterm2") {
      this.savedCapabilities = capabilities;
      setCapabilities({ ...capabilities, images: null });
      this.invalidate();
    }
    this.lastDocument = [];
    this.selectionAnchor = void 0;
    this.selectionFocus = void 0;
    this.selectionGranularity = "character";
    this.selectionInitialRange = void 0;
    this.lastClick = void 0;
    this.pressedUrl = void 0;
    this.selectionDragged = false;
    this.resetRenderState();
    const term = process.env.TERM?.toLowerCase() ?? "";
    const mouseSequence = process.env.TMUX !== void 0 || process.env.ZELLIJ !== void 0 || process.env.STY !== void 0 || term.startsWith("tmux") || term.startsWith("screen") ? ENABLE_BUTTON_MOTION_MOUSE : ENABLE_ALL_MOTION_MOUSE;
    this.terminal.write(`${ENTER_ALT_SCREEN}${DISABLE_AUTOWRAP}${this.mouseEnabled ? mouseSequence : ""}\x1B[2J\x1B[H\x1B[?25l`);
  }
  beforeTerminalStop(_options) {
    this.closeSearch();
    this.stopSelectionAutoScroll();
    this.selectionPressActive = false;
    this.stopScrollbarHover();
    this.stopScrollbarDrag();
    this.flashes.dispose();
    if (!this.altScreenActive)
      return;
    this.terminal.write(`${BEGIN_SYNCHRONIZED_OUTPUT}${this.deleteKittyImages()}${this.mouseEnabled ? DISABLE_MOUSE : ""}${ENABLE_AUTOWRAP}${END_SYNCHRONIZED_OUTPUT}`);
    this.uploadedKittyImages.clear();
  }
  afterTerminalStop(options) {
    if (!this.altScreenActive)
      return;
    this.altScreenActive = false;
    if (options.preserveScreen) {
      this.terminal.write(`${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}\x1B[?25h${END_SYNCHRONIZED_OUTPUT}`);
    } else {
      const width = Math.max(1, this.terminal.columns);
      const documentLines = this.render(width).map((line) => line.replace(OSC133_ZONE_PREFIX2, ""));
      this.lastDocument = this.applyLineResets(documentLines.map((line) => line.replaceAll(CURSOR_MARKER, ""))).map((line) => isImageLine(line) || visibleWidth(line) <= width ? line : sliceByColumn(line, 0, width, true));
      let buffer = `${BEGIN_SYNCHRONIZED_OUTPUT}${EXIT_ALT_SCREEN}${DISABLE_AUTOWRAP}`;
      for (let row = 0; row < this.lastDocument.length; row++) {
        if (row > 0)
          buffer += "\r\n";
        buffer += `\r\x1B[2K${this.lastDocument[row] ?? ""}`;
      }
      buffer += `\x1B[0m${ENABLE_AUTOWRAP}\r
\x1B[?25h${END_SYNCHRONIZED_OUTPUT}`;
      this.terminal.write(buffer);
    }
    if (this.savedCapabilities) {
      setCapabilities(this.savedCapabilities);
      this.savedCapabilities = void 0;
    }
  }
  deleteKittyImages() {
    return this.imageProtocol === "kitty" ? deleteAllKittyImages() : "";
  }
  prepareKittyScreen(screen) {
    const visibleImageIds = /* @__PURE__ */ new Set();
    const lines = screen.map((line) => {
      const placement = getKittyImagePlacement(line);
      if (!placement)
        return line;
      visibleImageIds.add(placement.imageId);
      const cachedImage = this.uploadedKittyImages.get(placement.imageId);
      const nextCachedImage = {
        transmissionGeneration: placement.transmissionGeneration,
        transmissionBytes: placement.transmissionBytes,
        estimatedDecodedBytes: placement.estimatedDecodedBytes
      };
      if (cachedImage)
        this.uploadedKittyImages.delete(placement.imageId);
      this.uploadedKittyImages.set(placement.imageId, nextCachedImage);
      return cachedImage?.transmissionGeneration === placement.transmissionGeneration ? placement.replacementLine : line;
    });
    let cachedOffscreenImageCount = 0;
    let cachedOffscreenTransmissionBytes = 0;
    let cachedOffscreenDecodedBytes = 0;
    for (const [imageId, cachedImage] of this.uploadedKittyImages) {
      if (visibleImageIds.has(imageId))
        continue;
      cachedOffscreenImageCount += 1;
      cachedOffscreenTransmissionBytes += cachedImage.transmissionBytes;
      cachedOffscreenDecodedBytes += cachedImage.estimatedDecodedBytes;
    }
    let evictedImageDeletion = "";
    for (const [imageId, cachedImage] of this.uploadedKittyImages) {
      if (cachedOffscreenImageCount <= MAX_CACHED_OFFSCREEN_KITTY_IMAGES && cachedOffscreenTransmissionBytes <= MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES && cachedOffscreenDecodedBytes <= MAX_CACHED_OFFSCREEN_KITTY_DECODED_BYTES) {
        break;
      }
      if (visibleImageIds.has(imageId))
        continue;
      evictedImageDeletion += deleteKittyImage(imageId);
      this.uploadedKittyImages.delete(imageId);
      cachedOffscreenImageCount -= 1;
      cachedOffscreenTransmissionBytes -= cachedImage.transmissionBytes;
      cachedOffscreenDecodedBytes -= cachedImage.estimatedDecodedBytes;
    }
    return { lines, evictedImageDeletion };
  }
  resetRenderState() {
    this.previousScreen = [];
    this.previousScreenWidth = 0;
    this.previousScreenHeight = 0;
    this.currentLayout = void 0;
  }
  scrollBy(lines) {
    this.getPrimaryScrollView().scrollBy(lines);
    this.requestRender();
  }
  scrollToTop() {
    this.getPrimaryScrollView().scrollToStart();
    this.requestRender();
  }
  scrollToBottom() {
    this.getPrimaryScrollView().scrollToEnd();
    this.requestRender();
  }
  scrollToPrompt(direction) {
    if (!this.currentLayout)
      return;
    const scrollView = this.getPrimaryScrollView();
    const lines = getScrollViewBox(this.currentLayout, scrollView)?.scrollContentLines;
    if (!lines)
      return;
    for (let row = scrollView.scrollTop + direction; row >= 0 && row < lines.length; row += direction) {
      if (!OSC133_PROMPT_START.test(lines[row] ?? ""))
        continue;
      scrollView.scrollTo(row);
      this.requestRender();
      return;
    }
  }
  openSearch() {
    if (this.activeSearch) {
      this.activeSearch.overlay?.focus();
      return;
    }
    const component = new AltScreenSearchComponent((query) => this.updateSearchQuery(query));
    const search = {
      component,
      query: "",
      matches: [],
      selectedIndex: -1,
      anchorRow: this.getPrimaryScrollView().scrollTop,
      selectionMode: "query"
    };
    this.activeSearch = search;
    search.overlay = this.showOverlay(component, {
      anchor: "top-right",
      width: "40%",
      minWidth: 24,
      margin: 1
    });
  }
  closeSearch() {
    const search = this.activeSearch;
    if (!search)
      return;
    this.activeSearch = void 0;
    search.overlay?.hide();
    this.requestRender();
  }
  updateSearchQuery(query) {
    const search = this.activeSearch;
    if (!search || query === search.query)
      return;
    const selected = search.matches[search.selectedIndex];
    search.anchorRow = selected?.segments[0]?.row ?? this.getPrimaryScrollView().scrollTop;
    search.query = query;
    search.selectionMode = "query";
    search.component.setResult(-1, 0);
    this.requestRender();
  }
  navigateSearch(direction) {
    const search = this.activeSearch;
    if (!search?.query)
      return;
    search.selectionMode = direction < 0 ? "previous" : "next";
    this.requestRender();
  }
  refreshSearch(layout) {
    const search = this.activeSearch;
    if (!search)
      return false;
    const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
    const box = getScrollViewBox(layout, scrollView);
    const lines = box?.scrollContentLines;
    if (!lines || !search.query.trim()) {
      search.matches = [];
      search.selectedIndex = -1;
      search.selectedKey = void 0;
      search.selectionMode = "retain";
      search.component.setResult(-1, 0);
      return false;
    }
    const shouldRevealSelection = search.selectionMode !== "retain";
    const matches = findAltScreenSearchMatches(lines, search.query);
    const exactIndex = search.selectedKey ? matches.findIndex((match) => getAltScreenSearchMatchKey(match) === search.selectedKey) : -1;
    let selectedIndex = -1;
    if (matches.length > 0) {
      if (search.selectionMode === "query") {
        selectedIndex = matches.findIndex((match) => (match.segments[0]?.row ?? 0) >= search.anchorRow);
        if (selectedIndex < 0)
          selectedIndex = 0;
      } else if (search.selectionMode === "next") {
        const baseIndex = exactIndex >= 0 ? exactIndex : Math.min(search.selectedIndex, matches.length - 1);
        selectedIndex = baseIndex < 0 ? 0 : (baseIndex + 1) % matches.length;
      } else if (search.selectionMode === "previous") {
        const baseIndex = exactIndex >= 0 ? exactIndex : Math.min(search.selectedIndex, matches.length - 1);
        selectedIndex = baseIndex < 0 ? matches.length - 1 : (baseIndex - 1 + matches.length) % matches.length;
      } else {
        selectedIndex = exactIndex >= 0 ? exactIndex : Math.min(Math.max(0, search.selectedIndex), matches.length - 1);
      }
    }
    search.matches = matches;
    search.selectedIndex = selectedIndex;
    search.selectedKey = selectedIndex >= 0 ? getAltScreenSearchMatchKey(matches[selectedIndex]) : void 0;
    search.selectionMode = "retain";
    search.component.setResult(selectedIndex, matches.length);
    if (!shouldRevealSelection)
      return false;
    const selected = matches[selectedIndex];
    const firstSegment = selected?.segments[0];
    const lastSegment = selected?.segments[selected.segments.length - 1];
    if (!box || !firstSegment || !lastSegment || scrollView.viewportHeight <= 0)
      return false;
    const before = scrollView.scrollTop;
    const visibleBottom = before + scrollView.viewportHeight - 1;
    let target = before;
    if (firstSegment.row < before || lastSegment.row > visibleBottom) {
      target = firstSegment.row - Math.floor(scrollView.viewportHeight / 3);
    }
    scrollView.scrollTo(target, { disableFollow: true });
    return scrollView.scrollTop !== before;
  }
  /** Show a transient message in the alternate-screen flash stack. */
  flash(message, durationMs2) {
    this.flashes.flash(message, durationMs2);
  }
  shouldDeferViewportInputToOverlay() {
    return this.isOverlayFocused() && this.activeSearch?.overlay?.isFocused() !== true;
  }
  handleViewportInput(data) {
    if (data === FOCUS_OUT) {
      const hadActiveSelection = this.selectionPressActive;
      const hadNonEmptyActiveSelection = hadActiveSelection && this.getSelectionBounds() !== void 0;
      this.selectionPressActive = false;
      this.stopSelectionAutoScroll();
      this.stopScrollbarHover();
      this.stopScrollbarDrag();
      this.pressedUrl = void 0;
      this.selectionDragged = false;
      if (hadActiveSelection) {
        this.selectionAnchor = void 0;
        this.selectionFocus = void 0;
        this.selectionGranularity = "character";
        this.selectionInitialRange = void 0;
        if (hadNonEmptyActiveSelection)
          this.requestRender();
      }
      this.lastClick = void 0;
      return { consume: true };
    }
    if (data === FOCUS_IN)
      return { consume: true };
    const wheelEvent = this.parseWheelEvent(data);
    if (wheelEvent) {
      if (this.shouldDeferViewportInputToOverlay())
        return void 0;
      this.routeWheel(wheelEvent);
      return { consume: true };
    }
    const mouseEvent = this.parseSgrMouseEvent(data);
    if (mouseEvent) {
      if (this.handleRightClickPaste(mouseEvent))
        return { consume: true };
      const handled = this.handleScrollbarMouseEvent(mouseEvent);
      if (!this.scrollbarDrag)
        this.updateScrollbarHover(mouseEvent.x, mouseEvent.y);
      if (!handled)
        this.handleSelectionMouseEvent(mouseEvent);
      return { consume: true };
    }
    if (this.isMouseSequence(data))
      return { consume: true };
    const keybindings = getKeybindings();
    const isRelease = isKeyRelease(data);
    if (keybindings.matches(data, "tui.altScreen.search")) {
      if (!isRelease)
        this.openSearch();
      return { consume: true };
    }
    if (this.activeSearch?.overlay?.isFocused()) {
      if (keybindings.matches(data, "tui.altScreen.searchNext")) {
        if (!isRelease)
          this.navigateSearch(1);
        return { consume: true };
      }
      if (keybindings.matches(data, "tui.altScreen.searchPrevious")) {
        if (!isRelease)
          this.navigateSearch(-1);
        return { consume: true };
      }
      if (keybindings.matches(data, "tui.altScreen.searchClose")) {
        if (!isRelease)
          this.closeSearch();
        return { consume: true };
      }
    }
    if (this.shouldDeferViewportInputToOverlay())
      return void 0;
    if (keybindings.matches(data, "tui.altScreen.pageUp")) {
      if (!isRelease) {
        this.scrollBy(-Math.max(1, this.getPrimaryScrollView().viewportHeight - PAGE_SCROLL_OVERLAP));
      }
      return { consume: true };
    }
    if (keybindings.matches(data, "tui.altScreen.pageDown")) {
      if (!isRelease) {
        this.scrollBy(Math.max(1, this.getPrimaryScrollView().viewportHeight - PAGE_SCROLL_OVERLAP));
      }
      return { consume: true };
    }
    if (keybindings.matches(data, "tui.altScreen.halfPageUp")) {
      if (!isRelease)
        this.scrollBy(-Math.max(1, Math.floor(this.getPrimaryScrollView().viewportHeight / 2)));
      return { consume: true };
    }
    if (keybindings.matches(data, "tui.altScreen.halfPageDown")) {
      if (!isRelease)
        this.scrollBy(Math.max(1, Math.floor(this.getPrimaryScrollView().viewportHeight / 2)));
      return { consume: true };
    }
    if (keybindings.matches(data, "tui.altScreen.lineUp")) {
      if (!isRelease)
        this.scrollBy(-1);
      return { consume: true };
    }
    if (keybindings.matches(data, "tui.altScreen.lineDown")) {
      if (!isRelease)
        this.scrollBy(1);
      return { consume: true };
    }
    if (keybindings.matches(data, "tui.altScreen.previousPrompt")) {
      if (!isRelease)
        this.scrollToPrompt(-1);
      return { consume: true };
    }
    if (keybindings.matches(data, "tui.altScreen.nextPrompt")) {
      if (!isRelease)
        this.scrollToPrompt(1);
      return { consume: true };
    }
    if (keybindings.matches(data, "tui.altScreen.top")) {
      if (!isRelease)
        this.scrollToTop();
      return { consume: true };
    }
    if (keybindings.matches(data, "tui.altScreen.bottom")) {
      if (!isRelease)
        this.scrollToBottom();
      return { consume: true };
    }
    return void 0;
  }
  parseWheelEvent(data) {
    const sgr = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/.exec(data);
    if (sgr) {
      const button = Number.parseInt(sgr[1], 10);
      if ((button & 64) === 0)
        return void 0;
      const direction = button & 3;
      if (direction !== 0 && direction !== 1)
        return void 0;
      return {
        direction: direction === 0 ? -1 : 1,
        x: Number.parseInt(sgr[2], 10) - 1,
        y: Number.parseInt(sgr[3], 10) - 1
      };
    }
    if (data.length === 6 && data.startsWith("\x1B[M")) {
      const button = data.charCodeAt(3) - 32;
      if ((button & 64) === 0)
        return void 0;
      const direction = button & 3;
      if (direction !== 0 && direction !== 1)
        return void 0;
      return {
        direction: direction === 0 ? -1 : 1,
        x: data.charCodeAt(4) - 33,
        y: data.charCodeAt(5) - 33
      };
    }
    return void 0;
  }
  routeWheel(event) {
    let remaining = event.direction * this.wheelScrollLines;
    const seen = /* @__PURE__ */ new Set();
    for (const scrollView of this.currentLayout ? getScrollViewsAt(this.currentLayout, event.x, event.y) : []) {
      seen.add(scrollView);
      remaining = scrollView.scrollBy(remaining);
      if (remaining === 0 || scrollView.overscroll === "contain")
        break;
    }
    const primary = this.getPrimaryScrollView();
    if (remaining !== 0 && !seen.has(primary))
      primary.scrollBy(remaining);
    this.updateScrollbarHover(event.x, event.y);
    this.requestRender();
  }
  parseSgrMouseEvent(data) {
    const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
    if (!match)
      return void 0;
    return {
      button: Number.parseInt(match[1], 10),
      x: Number.parseInt(match[2], 10) - 1,
      y: Number.parseInt(match[3], 10) - 1,
      release: match[4] === "m"
    };
  }
  handleRightClickPaste(event) {
    if (!this.onRightClickPaste || process.platform !== "win32" || process.env.TERM_PROGRAM?.toLowerCase() === "vscode" || event.release || event.button !== 2) {
      return false;
    }
    try {
      this.onRightClickPaste();
    } catch {
    }
    return true;
  }
  getScrollbarTargetAt(x2, y2) {
    if (this.hasOverlay() || !this.currentLayout)
      return void 0;
    for (const scrollView of getScrollViewsAt(this.currentLayout, x2, y2)) {
      const box = getScrollViewBox(this.currentLayout, scrollView);
      const geometry = box ? getScrollbarGeometry(box) : void 0;
      if (geometry && x2 === geometry.column && y2 >= geometry.thumbTop && y2 < geometry.thumbTop + geometry.thumbHeight) {
        return { scrollView, geometry };
      }
    }
    return void 0;
  }
  setScrollbarHover(scrollView) {
    if (scrollView === this.scrollbarHover)
      return;
    this.scrollbarHover?.setScrollbarActive(false);
    this.scrollbarHover = scrollView;
    this.scrollbarHover?.setScrollbarActive(true);
  }
  updateScrollbarHover(x2, y2) {
    this.setScrollbarHover(this.getScrollbarTargetAt(x2, y2)?.scrollView);
  }
  stopScrollbarHover() {
    this.setScrollbarHover(void 0);
  }
  handleScrollbarMouseEvent(event) {
    if (this.scrollbarDrag) {
      if (event.release) {
        this.stopScrollbarDrag();
        return true;
      }
      const box = this.currentLayout ? getScrollViewBox(this.currentLayout, this.scrollbarDrag.scrollView) : void 0;
      const geometry = box ? getScrollbarGeometry(box) : void 0;
      if (geometry) {
        const maxThumbOffset = geometry.trackHeight - geometry.thumbHeight;
        const thumbOffset = Math.max(0, Math.min(maxThumbOffset, event.y - geometry.trackTop - this.scrollbarDrag.grabOffset));
        const scrollTop = maxThumbOffset === 0 ? 0 : Math.round(thumbOffset / maxThumbOffset * geometry.maxScrollTop);
        this.scrollbarDrag.scrollView.scrollTo(scrollTop);
      }
      return true;
    }
    if (event.release || (event.button & 32) !== 0 || (event.button & 3) !== 0)
      return false;
    const target = this.getScrollbarTargetAt(event.x, event.y);
    if (!target)
      return false;
    this.stopSelectionAutoScroll();
    this.selectionPressActive = false;
    this.selectionAnchor = void 0;
    this.selectionFocus = void 0;
    this.selectionGranularity = "character";
    this.selectionInitialRange = void 0;
    this.lastClick = void 0;
    this.pressedUrl = void 0;
    this.selectionDragged = false;
    this.setScrollbarHover(target.scrollView);
    this.scrollbarDrag = {
      scrollView: target.scrollView,
      grabOffset: event.y - target.geometry.thumbTop
    };
    return true;
  }
  stopScrollbarDrag() {
    this.scrollbarDrag = void 0;
  }
  getScrollSelectionPoint(scrollView, x2, y2) {
    if (!this.currentLayout)
      return void 0;
    const box = getScrollViewBox(this.currentLayout, scrollView);
    if (!box || box.rect.height <= 0 || box.clip.height <= 0)
      return void 0;
    const visibleTop = Math.max(0, box.rect.y, box.clip.y);
    const visibleBottom = Math.min(this.terminal.rows - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
    if (visibleBottom < visibleTop)
      return void 0;
    const pointerRow = Math.max(visibleTop, Math.min(visibleBottom, y2));
    const maxContentRow = Math.max(0, (box.scrollContentLines?.length ?? 1) - 1);
    return {
      row: Math.max(0, Math.min(maxContentRow, scrollView.scrollTop + pointerRow - box.rect.y)),
      col: Math.max(0, Math.min(box.rect.width - 1, x2 - box.rect.x)),
      scrollView
    };
  }
  getSelectionPoint(event, scrollView) {
    if (scrollView) {
      const point = this.getScrollSelectionPoint(scrollView, event.x, event.y);
      if (point)
        return point;
    }
    return {
      row: Math.max(0, Math.min(this.terminal.rows - 1, event.y)),
      col: Math.max(0, Math.min(this.terminal.columns - 1, event.x))
    };
  }
  getSelectionSourceLine(point) {
    if (point.scrollView && this.currentLayout) {
      const lines = getScrollViewBox(this.currentLayout, point.scrollView)?.scrollContentLines;
      if (lines)
        return lines[point.row] ?? "";
    }
    return this.previousScreen[point.row] ?? "";
  }
  getWordSelection(point) {
    const line = stripTerminalSequences(this.getSelectionSourceLine(point));
    let start = 0;
    for (const segment of wordSegmenter4.segment(line)) {
      const end = start + visibleWidth(segment.segment);
      if (point.col >= start && point.col < end) {
        return {
          start: { ...point, col: start },
          end: { ...point, col: end, boundary: true }
        };
      }
      start = end;
    }
    return void 0;
  }
  getLineSelection(point) {
    return {
      start: { ...point, col: 0 },
      end: { ...point, col: visibleWidth(this.getSelectionSourceLine(point)), boundary: true }
    };
  }
  updateSelectionFocus(point) {
    if (this.selectionGranularity === "character" || !this.selectionInitialRange) {
      this.selectionFocus = point;
      return;
    }
    const range = this.selectionGranularity === "word" ? this.getWordSelection(point) : this.getLineSelection(point);
    if (!range)
      return;
    const initial = this.selectionInitialRange;
    const targetBeforeInitial = range.start.row < initial.start.row || range.start.row === initial.start.row && range.start.col < initial.start.col;
    if (targetBeforeInitial) {
      this.selectionAnchor = initial.end;
      this.selectionFocus = range.start;
    } else {
      this.selectionAnchor = initial.start;
      this.selectionFocus = range.end;
    }
  }
  getClickCount(point, word) {
    const now = Date.now();
    const previous = this.lastClick;
    const count = word && previous && now - previous.timestamp <= DOUBLE_CLICK_INTERVAL_MS && previous.row === point.row && previous.scrollView === point.scrollView && previous.wordStart === word.start.col && previous.wordEnd === word.end.col ? previous.count % 3 + 1 : 1;
    this.lastClick = word ? {
      timestamp: now,
      count,
      row: point.row,
      scrollView: point.scrollView,
      wordStart: word.start.col,
      wordEnd: word.end.col
    } : void 0;
    return count;
  }
  updateSelectionAutoScroll(event) {
    const scrollView = this.selectionAnchor?.scrollView;
    if (!scrollView || !this.currentLayout) {
      this.stopSelectionAutoScroll();
      return;
    }
    const box = getScrollViewBox(this.currentLayout, scrollView);
    if (!box || box.rect.height <= 0 || box.clip.height <= 0) {
      this.stopSelectionAutoScroll();
      return;
    }
    const visibleTop = Math.max(0, box.rect.y, box.clip.y);
    const visibleBottom = Math.min(this.terminal.rows - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
    this.selectionDragPointer = { x: event.x, y: event.y };
    this.selectionAutoScrollDirection = event.y <= visibleTop ? -1 : event.y >= visibleBottom ? 1 : 0;
    if (this.selectionAutoScrollDirection === 0) {
      this.stopSelectionAutoScroll();
      return;
    }
    if (this.selectionAutoScrollTimer)
      return;
    this.selectionAutoScrollTimer = setInterval(() => this.autoScrollSelection(), 50);
    this.selectionAutoScrollTimer.unref();
  }
  autoScrollSelection() {
    const scrollView = this.selectionAnchor?.scrollView;
    const pointer = this.selectionDragPointer;
    const direction = this.selectionAutoScrollDirection;
    if (!scrollView || !pointer || direction === 0) {
      this.stopSelectionAutoScroll();
      return;
    }
    const remaining = scrollView.scrollBy(direction);
    if (remaining === direction) {
      this.stopSelectionAutoScroll();
      return;
    }
    const point = this.getScrollSelectionPoint(scrollView, pointer.x, pointer.y);
    if (point)
      this.updateSelectionFocus(point);
    this.requestRender();
  }
  stopSelectionAutoScroll() {
    if (this.selectionAutoScrollTimer) {
      clearInterval(this.selectionAutoScrollTimer);
      this.selectionAutoScrollTimer = void 0;
    }
    this.selectionAutoScrollDirection = 0;
    this.selectionDragPointer = void 0;
  }
  handleSelectionMouseEvent(event) {
    const button = event.button & 3;
    if (button !== 0 && !(event.release && button === 3))
      return;
    const anchorScrollView = this.selectionAnchor?.scrollView;
    const point = this.getSelectionPoint(event, anchorScrollView);
    if (event.release) {
      if (!this.selectionPressActive)
        return;
      this.selectionPressActive = false;
      this.stopSelectionAutoScroll();
      if (!this.selectionAnchor)
        return;
      this.updateSelectionFocus(point);
      const clickedUrl = !this.selectionDragged && this.selectionAnchor.scrollView === point.scrollView && this.selectionAnchor.row === point.row && this.selectionAnchor.col === point.col ? this.pressedUrl : void 0;
      this.pressedUrl = void 0;
      if (clickedUrl && this.openUrl) {
        this.selectionAnchor = void 0;
        this.selectionFocus = void 0;
        try {
          this.openUrl(clickedUrl);
        } catch {
        }
        this.requestRender();
        return;
      }
      void this.copySelectionToClipboard();
      this.requestRender();
      return;
    }
    if ((event.button & 32) !== 0) {
      if (!this.selectionPressActive || !this.selectionAnchor)
        return;
      this.selectionDragged = true;
      this.lastClick = void 0;
      this.pressedUrl = void 0;
      this.updateSelectionFocus(point);
      this.updateSelectionAutoScroll(event);
      this.requestRender();
      return;
    }
    this.stopSelectionAutoScroll();
    this.selectionPressActive = true;
    const scrollView = !this.hasOverlay() && this.currentLayout ? getScrollViewsAt(this.currentLayout, event.x, event.y)[0] : void 0;
    const anchor = this.getSelectionPoint(event, scrollView);
    const word = this.getWordSelection(anchor);
    const clickCount = this.getClickCount(anchor, word);
    const range = clickCount === 2 ? word : clickCount === 3 ? this.getLineSelection(anchor) : void 0;
    this.selectionGranularity = range ? clickCount === 2 ? "word" : "line" : "character";
    this.selectionInitialRange = range;
    this.selectionAnchor = range?.start ?? anchor;
    this.selectionFocus = range?.end ?? anchor;
    this.selectionDragged = false;
    this.pressedUrl = range ? void 0 : getOsc8LinkAtColumn(this.previousScreen[Math.max(0, Math.min(this.terminal.rows - 1, event.y))] ?? "", Math.max(0, Math.min(this.terminal.columns - 1, event.x)));
    this.requestRender();
  }
  getSelectionBounds() {
    if (!this.selectionAnchor || !this.selectionFocus)
      return void 0;
    if (this.selectionAnchor.scrollView !== this.selectionFocus.scrollView)
      return void 0;
    const anchorBeforeFocus = this.selectionAnchor.row < this.selectionFocus.row || this.selectionAnchor.row === this.selectionFocus.row && this.selectionAnchor.col < this.selectionFocus.col;
    if (this.selectionAnchor.row === this.selectionFocus.row && this.selectionAnchor.col === this.selectionFocus.col) {
      return void 0;
    }
    return anchorBeforeFocus ? { start: this.selectionAnchor, end: this.selectionFocus } : { start: this.selectionFocus, end: this.selectionAnchor };
  }
  getSelectionColumns(line, row, selection, minColumn = 0, maxColumn = visibleWidth(line)) {
    const lineWidth = visibleWidth(line);
    let start = Math.max(0, minColumn);
    let end = Math.min(lineWidth, maxColumn);
    if (row === selection.start.row) {
      start = getGraphemeCellRange(line, selection.start.col)?.start ?? Math.min(selection.start.col, lineWidth);
    }
    if (row === selection.end.row) {
      end = selection.end.boundary ? Math.min(selection.end.col, lineWidth) : getGraphemeCellRange(line, selection.end.col)?.end ?? Math.min(selection.end.col + 1, lineWidth);
    }
    return { start: Math.max(minColumn, start), end: Math.min(maxColumn, end) };
  }
  async copySelectionToClipboard() {
    const selection = this.getSelectionBounds();
    if (!selection)
      return;
    let sourceLines = this.previousScreen;
    if (selection.start.scrollView) {
      if (!this.currentLayout)
        return;
      const box = getScrollViewBox(this.currentLayout, selection.start.scrollView);
      if (!box?.scrollContentLines)
        return;
      sourceLines = box.scrollContentLines;
    }
    const lines = [];
    for (let row = selection.start.row; row <= selection.end.row; row++) {
      const line = sourceLines[row] ?? "";
      const columns = this.getSelectionColumns(line, row, selection);
      lines.push(stripTerminalSequences(sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true)).trimEnd());
    }
    const text = lines.join("\n");
    if (text.length === 0)
      return;
    if (this.copySelection) {
      const ok = await this.copySelection(text);
      this.flash(ok ? "Copied!" : "Copy failed");
      return;
    }
    this.terminal.write(`\x1B]52;c;${Buffer.from(text).toString("base64")}\x07`);
    this.flash("Copied!");
  }
  applySearchTextHighlight(text, current) {
    const style = current ? this.searchCurrentMatchStyle : this.searchMatchStyle;
    let result = "";
    let plainStart = 0;
    let index = 0;
    while (index < text.length) {
      const ansi = extractAnsiCode(text, index);
      if (!ansi) {
        index += 1;
        continue;
      }
      if (index > plainStart)
        result += style(text.slice(plainStart, index));
      result += ansi.code;
      index += ansi.length;
      plainStart = index;
    }
    if (plainStart < text.length)
      result += style(text.slice(plainStart));
    return result;
  }
  applySearchHighlights(screen, layout) {
    const search = this.activeSearch;
    if (!search || search.selectedIndex < 0 || search.matches.length === 0)
      return screen;
    const scrollView = layout.primaryScrollView ?? this.implicitScrollView;
    const box = getScrollViewBox(layout, scrollView);
    if (!box)
      return screen;
    const rangesByRow = /* @__PURE__ */ new Map();
    const scrollbarColumn = getScrollbarGeometry(box)?.column;
    const minRow = Math.max(0, box.rect.y, box.clip.y);
    const maxRow = Math.min(screen.length, box.rect.y + box.rect.height, box.clip.y + box.clip.height);
    const minColumn = Math.max(0, box.rect.x, box.clip.x);
    const maxColumn = Math.min(this.terminal.columns, box.rect.x + box.rect.width, box.clip.x + box.clip.width, scrollbarColumn ?? Number.POSITIVE_INFINITY);
    for (let matchIndex = 0; matchIndex < search.matches.length; matchIndex++) {
      for (const segment of search.matches[matchIndex].segments) {
        const row = box.rect.y + segment.row - scrollView.scrollTop;
        if (row < minRow || row >= maxRow)
          continue;
        const startCol = Math.max(minColumn, box.rect.x + segment.startCol);
        const endCol = Math.min(maxColumn, box.rect.x + segment.endCol);
        if (endCol <= startCol)
          continue;
        const ranges = rangesByRow.get(row) ?? [];
        ranges.push({ startCol, endCol, current: matchIndex === search.selectedIndex });
        rangesByRow.set(row, ranges);
      }
    }
    const result = [...screen];
    for (const [row, ranges] of rangesByRow) {
      let line = result[row] ?? "";
      if (isImageLine(line))
        continue;
      const lineWidth = visibleWidth(line);
      for (const range of ranges.sort((a, b2) => b2.startCol - a.startCol)) {
        const startCol = Math.min(range.startCol, lineWidth);
        const endCol = Math.min(range.endCol, lineWidth);
        if (endCol <= startCol)
          continue;
        const before = sliceByColumn(line, 0, startCol, true);
        const highlighted = sliceByColumn(line, startCol, endCol - startCol, true);
        const after = sliceByColumn(line, endCol, Math.max(0, lineWidth - endCol), true);
        line = `${before}${this.applySearchTextHighlight(highlighted, range.current)}${after}`;
      }
      result[row] = line;
    }
    return result;
  }
  applySelectionHighlight(text) {
    let result = "\x1B[7m";
    let index = 0;
    while (index < text.length) {
      const ansi = extractAnsiCode(text, index);
      if (!ansi) {
        result += text[index];
        index += 1;
        continue;
      }
      result += ansi.code;
      if (ansi.code.endsWith("m"))
        result += "\x1B[7m";
      index += ansi.length;
    }
    return `${result}\x1B[27m`;
  }
  applySelection(screen, layout = this.currentLayout) {
    const selection = this.getSelectionBounds();
    if (!selection)
      return screen;
    let screenSelection = selection;
    let minRow = 0;
    let maxRow = screen.length - 1;
    let minColumn = 0;
    let maxColumn = this.terminal.columns;
    if (selection.start.scrollView) {
      if (!layout)
        return screen;
      const box = getScrollViewBox(layout, selection.start.scrollView);
      if (!box)
        return screen;
      minRow = Math.max(0, box.rect.y, box.clip.y);
      maxRow = Math.min(screen.length - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
      minColumn = Math.max(0, box.rect.x, box.clip.x);
      maxColumn = Math.min(this.terminal.columns, box.rect.x + box.rect.width, box.clip.x + box.clip.width);
      screenSelection = {
        start: {
          ...selection.start,
          row: box.rect.y + selection.start.row - selection.start.scrollView.scrollTop,
          col: box.rect.x + selection.start.col
        },
        end: {
          ...selection.end,
          row: box.rect.y + selection.end.row - selection.start.scrollView.scrollTop,
          col: box.rect.x + selection.end.col
        }
      };
    }
    return screen.map((line, row) => {
      if (row < minRow || row > maxRow || row < screenSelection.start.row || row > screenSelection.end.row || isImageLine(line)) {
        return line;
      }
      const lineWidth = visibleWidth(line);
      const columns = this.getSelectionColumns(line, row, screenSelection, minColumn, maxColumn);
      if (columns.end <= columns.start)
        return line;
      const before = sliceByColumn(line, 0, columns.start, true);
      const selected = sliceByColumn(line, columns.start, columns.end - columns.start, true);
      const after = sliceByColumn(line, columns.end, Math.max(0, lineWidth - columns.end), true);
      return `${before}${this.applySelectionHighlight(selected)}${after}`;
    });
  }
  isMouseSequence(data) {
    return /^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || data.length === 6 && data.startsWith("\x1B[M");
  }
  compositeFlashes(screen, width, height) {
    const flashLines = this.flashes.render(width).slice(-height);
    if (flashLines.length === 0)
      return screen;
    const result = [...screen];
    while (result.length < height)
      result.push("");
    for (let row = 0; row < flashLines.length; row++) {
      const line = flashLines[row];
      const flashWidth = visibleWidth(line);
      if (flashWidth === 0)
        continue;
      result[row] = compositeTuiLine(result[row] ?? "", line, width - flashWidth, flashWidth, width);
    }
    return result;
  }
  doRender() {
    if (this.stopped || !this.altScreenActive)
      return;
    const width = Math.max(1, this.terminal.columns);
    const height = Math.max(1, this.terminal.rows);
    const root = this.layoutRoot ?? this.implicitScrollView;
    let nextLayout = renderLayoutFrame(root, width, height, () => this.requestRender());
    if (this.refreshSearch(nextLayout)) {
      nextLayout = renderLayoutFrame(root, width, height, () => this.requestRender());
    }
    let screen = nextLayout.lines.map((line) => line.replace(OSC133_ZONE_PREFIX2, ""));
    screen = this.applySearchHighlights(screen, nextLayout);
    screen = this.compositeOverlays(screen, width, height);
    if (screen.length > height)
      screen = screen.slice(screen.length - height);
    screen = this.applySelection(screen, nextLayout);
    screen = this.compositeFlashes(screen, width, height);
    const cursorPos = this.extractCursorPosition(screen, height);
    screen = this.applyLineResets(screen).map((line) => {
      if (isImageLine(line) || visibleWidth(line) <= width)
        return line;
      return sliceByColumn(line, 0, width, true);
    });
    const fullRedraw = this.previousScreen.length === 0 || this.previousScreenWidth !== width || this.previousScreenHeight !== height;
    const imagesNeedRedraw = screen.some((line, row) => line !== this.previousScreen[row] && (isImageLine(line) || isImageLine(this.previousScreen[row] ?? "")));
    const redrawImages = fullRedraw || imagesNeedRedraw;
    const hadUploadedKittyImages = this.uploadedKittyImages.size > 0;
    const preparedKittyScreen = redrawImages && this.imageProtocol === "kitty" ? this.prepareKittyScreen(screen) : { lines: screen, evictedImageDeletion: "" };
    let buffer = BEGIN_SYNCHRONIZED_OUTPUT;
    if (fullRedraw) {
      this.fullRedrawCount += 1;
      const clearImages = this.imageProtocol === "kitty" && hadUploadedKittyImages ? deleteAllKittyPlacements() : this.deleteKittyImages();
      buffer += `${clearImages}\x1B[2J`;
    } else if (imagesNeedRedraw) {
      if (this.imageProtocol === "iterm2")
        buffer += "\x1B[2J";
      else if (this.imageProtocol === "kitty")
        buffer += deleteAllKittyPlacements();
    }
    buffer += preparedKittyScreen.evictedImageDeletion;
    for (let row = 0; row < height; row++) {
      if (!fullRedraw && !imagesNeedRedraw && screen[row] === this.previousScreen[row])
        continue;
      buffer += `\x1B[${row + 1};1H\x1B[2K${preparedKittyScreen.lines[row] ?? ""}`;
    }
    if (cursorPos) {
      buffer += `\x1B[${cursorPos.row + 1};${Math.min(width, cursorPos.col) + 1}H`;
      buffer += this.getShowHardwareCursor() ? "\x1B[?25h" : "\x1B[?25l";
    } else {
      buffer += "\x1B[?25l";
    }
    buffer += END_SYNCHRONIZED_OUTPUT;
    this.terminal.write(buffer);
    this.previousScreen = screen;
    this.previousScreenWidth = width;
    this.previousScreenHeight = height;
    this.currentLayout = nextLayout;
  }
};

// plugins/kxm-mesh/src/tui.ts
var MESH_TUI_PANELS = ["agents", "messages", "runs", "pids"];
function defaultMeshTuiView() {
  return {
    focus: "agents",
    open: { agents: true, messages: true, runs: false, pids: false },
    help: false
  };
}
function applyMeshTuiKey(view, key) {
  if (matchesKey(key, "q") || matchesKey(key, Key.ctrl("c"))) return "quit";
  if (matchesKey(key, Key.escape)) return view.help ? { ...view, help: false } : "quit";
  if (matchesKey(key, "h") || matchesKey(key, "?")) return { ...view, help: !view.help };
  const byNumber = { "1": "agents", "2": "messages", "3": "runs", "4": "pids" };
  const panel = byNumber[key];
  if (panel) {
    return { ...view, focus: panel, help: false, open: { ...view.open, [panel]: true } };
  }
  if (matchesKey(key, Key.space) || matchesKey(key, Key.enter)) {
    return { ...view, help: false, open: { ...view.open, [view.focus]: !view.open[view.focus] } };
  }
  const index = MESH_TUI_PANELS.indexOf(view.focus);
  if (matchesKey(key, Key.up)) {
    return { ...view, help: false, focus: MESH_TUI_PANELS[(index - 1 + MESH_TUI_PANELS.length) % MESH_TUI_PANELS.length] };
  }
  if (matchesKey(key, Key.down) || matchesKey(key, Key.tab)) {
    return { ...view, help: false, focus: MESH_TUI_PANELS[(index + 1) % MESH_TUI_PANELS.length] };
  }
  return view;
}
function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function age(iso, now) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const s = Math.floor(ms / 1e3);
  if (s < 60) return `${s}s`;
  const m2 = Math.floor(s / 60);
  if (m2 < 60) return `${m2}m`;
  const h = Math.floor(m2 / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function pad(value, width) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= width) return text.padEnd(width);
  return `${text.slice(0, Math.max(0, width - 1))}\u2026`;
}
function readJsonRows(database, sql) {
  const rows = database.prepare(sql).all();
  const out = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.record));
    } catch {
    }
  }
  return out;
}
function countRows(database, table, where = "") {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`).get();
  return Number(row?.count ?? 0);
}
function readOpenMessageMetadata(database) {
  const rows = database.prepare(`
    SELECT
      json_extract(record, '$.id') AS id,
      json_extract(record, '$.status') AS status,
      COALESCE(json_extract(record, '$.fromName'), json_extract(record, '$.from')) AS fromName,
      COALESCE(json_extract(record, '$.toName'), json_extract(record, '$.to')) AS toName,
      json_extract(record, '$.delivery') AS delivery,
      json_extract(record, '$.createdAt') AS createdAt,
      json_extract(record, '$.correlationId') AS correlationId
    FROM messages
    WHERE json_extract(record, '$.status') IN ('queued', 'delivered')
    ORDER BY json_extract(record, '$.createdAt') DESC
    LIMIT 16
  `).all();
  const messages = [];
  for (const row of rows) {
    if (typeof row.id !== "string" || row.status !== "queued" && row.status !== "delivered" || typeof row.fromName !== "string" || typeof row.toName !== "string" || row.delivery !== "steer" && row.delivery !== "followUp" && row.delivery !== "nextTurn" || typeof row.createdAt !== "string") continue;
    messages.push({
      id: row.id,
      status: row.status,
      fromName: row.fromName,
      toName: row.toName,
      delivery: row.delivery,
      createdAt: row.createdAt,
      ...typeof row.correlationId === "string" ? { correlationId: row.correlationId } : {}
    });
  }
  return messages;
}
function loadLocalMeshSnapshot(dataPath, stateDir) {
  let agents = [];
  let openMessages = [];
  let openMessageTotal = 0;
  let runs = [];
  let runTotal = 0;
  if (existsSync2(dataPath)) {
    const database = new DatabaseSync(dataPath, { readOnly: true });
    try {
      agents = readJsonRows(database, "SELECT record FROM agents");
      openMessages = readOpenMessageMetadata(database);
      openMessageTotal = countRows(database, "messages", " WHERE json_extract(record, '$.status') IN ('queued', 'delivered')");
      runs = readJsonRows(database, "SELECT record FROM workflow_runs ORDER BY rowid DESC LIMIT 8");
      runTotal = countRows(database, "workflow_runs");
    } finally {
      database.close();
    }
  }
  const pids = [];
  if (existsSync2(stateDir)) {
    for (const file of readdirSync(stateDir).filter((name) => name.endsWith(".pid"))) {
      try {
        const record = JSON.parse(readFileSync3(join8(stateDir, file), "utf8"));
        pids.push({
          file,
          ...record.role ? { role: record.role } : {},
          ...record.pid !== void 0 ? { pid: record.pid } : {},
          live: Number.isInteger(record.pid) && record.pid > 0 && processExists(record.pid)
        });
      } catch {
        pids.push({ file, live: false });
      }
    }
  }
  return {
    agents: agents.sort((a, b2) => Number(b2.online) - Number(a.online) || a.name.localeCompare(b2.name)),
    openMessages,
    openMessageTotal,
    runs: runs.map((run) => ({
      id: run.id,
      status: run.status,
      definitionId: run.definitionId,
      project: run.project
    })),
    runTotal,
    pids
  };
}
function meshTuiTheme(color) {
  const ansi = (code) => color ? (text) => `\x1B[${code}m${text}\x1B[0m` : (text) => text;
  return {
    accent: ansi("1;36"),
    dim: ansi("2"),
    error: ansi("1;31"),
    success: ansi("1;32"),
    warning: ansi("1;33"),
    headerBg: ansi("1;97;44"),
    panelBg: ansi("48;5;236")
  };
}
function settingsTheme(theme) {
  return {
    label: (text, selected) => selected ? theme.accent(text) : text,
    value: (text, selected) => selected ? theme.warning(text) : theme.dim(text),
    description: theme.dim,
    cursor: theme.accent("\u203A "),
    hint: theme.dim
  };
}
function visibleAgents(snapshot) {
  return snapshot.agents.filter((agent) => agent.model !== "kxm-tui");
}
function panelMetric(snapshot, panel) {
  if (panel === "agents") {
    const agents = visibleAgents(snapshot);
    return `${agents.filter((agent) => agent.online).length}/${agents.length}`;
  }
  if (panel === "messages") return snapshot.openMessages.length === snapshot.openMessageTotal ? String(snapshot.openMessageTotal) : `${snapshot.openMessages.length}/${snapshot.openMessageTotal}`;
  if (panel === "runs") return snapshot.runs.length === snapshot.runTotal ? String(snapshot.runTotal) : `${snapshot.runs.length}/${snapshot.runTotal}`;
  return `${snapshot.pids.filter((claim) => claim.live).length}/${snapshot.pids.length}`;
}
function panelRows(snapshot, panel, theme) {
  const now = Date.parse(snapshot.fetchedAt);
  if (panel === "agents") {
    const agents = visibleAgents(snapshot);
    return agents.length === 0 ? [] : [
      theme.dim(`${pad("name", 14)} ${pad("on", 3)} ${pad("model", 24)} ${pad("seen", 4)} purpose`),
      ...agents.map((agent) => `${pad(agent.name, 14)} ${agent.online ? theme.success(pad("yes", 3)) : theme.dim(pad("no", 3))} ${pad(agent.model ?? "-", 24)} ${pad(age(agent.lastSeenAt, now), 4)} ${agent.purpose}`)
    ];
  }
  if (panel === "messages") {
    return snapshot.openMessages.length === 0 ? [] : [
      theme.dim(`${pad("state", 9)} ${pad("from", 12)} ${pad("to", 12)} ${pad("mode", 8)} ${pad("age", 4)} id`),
      ...snapshot.openMessages.map((message) => `${theme.warning(pad(message.status, 9))} ${pad(message.fromName, 12)} ${pad(message.toName, 12)} ${pad(message.delivery, 8)} ${pad(age(message.createdAt, now), 4)} ${message.id}`),
      ...snapshot.openMessageTotal > snapshot.openMessages.length ? [theme.dim(`\u2026 +${snapshot.openMessageTotal - snapshot.openMessages.length} more`)] : []
    ];
  }
  if (panel === "runs") {
    return [
      ...snapshot.runs.map((run) => `${pad(run.status, 10)} ${pad(run.definitionId, 20)} ${run.project}  ${run.id}`),
      ...snapshot.runTotal > snapshot.runs.length ? [theme.dim(`\u2026 +${snapshot.runTotal - snapshot.runs.length} more`)] : []
    ];
  }
  return snapshot.pids.map((claim) => `${claim.live ? theme.success("live") : theme.error("dead")}  ${pad(claim.role ?? "-", 8)} pid=${claim.pid ?? "-"}  ${claim.file}`);
}
function dataPanel(title, metric, rows, emptyText, theme) {
  const panel = new Box(1, 0, theme.panelBg);
  panel.addChild(new Text(`${theme.accent(`\u258C ${title}`)}  ${theme.dim(metric)}`, 0, 0));
  const table = new Container();
  if (rows.length === 0) {
    table.addChild(new Text(theme.dim(emptyText), 0, 0));
  } else {
    for (const row of rows) table.addChild(new TruncatedText(row, 0, 0));
  }
  panel.addChild(table);
  return panel;
}
var MeshDashboard = class {
  root = new VStack([], { gap: 1 });
  content = new VStack([], { gap: 1 });
  scrollView = new ScrollView(this.content, { primary: true, overscroll: "contain", scrollbar: "auto" });
  settings;
  snapshot;
  view;
  color;
  requestRender;
  onQuit;
  getWidth;
  constructor(snapshot, view, color, requestRender, onQuit, getWidth = () => 120) {
    this.snapshot = snapshot;
    this.view = view;
    this.color = color;
    this.requestRender = requestRender;
    this.onQuit = onQuit;
    this.getWidth = getWidth;
    this.rebuild();
  }
  update(snapshot) {
    this.snapshot = snapshot;
    this.rebuild();
    this.requestRender();
  }
  toggle(panel, visible) {
    this.view = {
      ...this.view,
      focus: panel,
      help: false,
      open: { ...this.view.open, [panel]: visible ?? !this.view.open[panel] }
    };
    this.rebuild();
    this.requestRender();
  }
  rebuild() {
    const theme = meshTuiTheme(this.color);
    const title = new TruncatedText(theme.accent("KXM MESH"), 0, 0);
    const hub = this.snapshot.healthOk ? theme.success("\u25CF hub ok") : theme.error("\u2717 hub down");
    const ready = this.snapshot.readyOk ? theme.success("\u25CF ready") : theme.error("\u2717 not ready");
    const agents = visibleAgents(this.snapshot);
    const online = agents.filter((agent) => agent.online).length;
    const transport = this.snapshot.transport === "sse" ? "live" : "snapshot";
    const updated = this.snapshot.fetchedAt.slice(11, 19);
    const status = new TruncatedText(
      `${hub}  ${ready}  ${transport}  ${online}/${agents.length} online  ${theme.dim(`updated ${updated} UTC \xB7 ${this.snapshot.serverUrl}`)}`,
      0,
      0
    );
    const header = new Box(1, 0, theme.headerBg);
    header.addChild(new HStack([
      { component: title, basis: 16, shrink: 1, minSize: 10 },
      { component: status, grow: 1, shrink: 1, minSize: 20 }
    ], { gap: 2 }));
    const items = [
      { id: "agents", label: `Agents (${panelMetric(this.snapshot, "agents")})`, description: "Online / known; model state", currentValue: this.view.open.agents ? "show" : "hide", values: ["show", "hide"] },
      { id: "messages", label: `Messages (${panelMetric(this.snapshot, "messages")})`, description: "Metadata only \u2014 never bodies", currentValue: this.view.open.messages ? "show" : "hide", values: ["show", "hide"] },
      { id: "runs", label: `Runs (${panelMetric(this.snapshot, "runs")})`, description: "Durable workflow state", currentValue: this.view.open.runs ? "show" : "hide", values: ["show", "hide"] },
      { id: "pids", label: `PIDs (${panelMetric(this.snapshot, "pids")})`, description: "Live / claimed processes", currentValue: this.view.open.pids ? "show" : "hide", values: ["show", "hide"] }
    ];
    this.settings = new SettingsList(
      items,
      items.length + 2,
      settingsTheme(theme),
      (id, value) => this.toggle(id, value === "show"),
      this.onQuit
    );
    this.settings.selectItem(this.view.focus);
    const sidebar = new Box(1, 0);
    sidebar.addChild(new Text(theme.accent("PANELS"), 0, 0));
    sidebar.addChild(this.settings);
    const content = this.content;
    content.clear();
    if (this.view.help) {
      const help = new Box(1, 0, theme.panelBg);
      help.addChild(new Text(`${theme.accent("HELP")}
\u2191\u2193 select panels \xB7 enter/space toggle \xB7 1\u20134 reveal \xB7 PgUp/PgDn or Ctrl-U/D scroll \xB7 h hide help \xB7 q quit
On narrow screens \u2191\u2193 scrolls content. Esc closes help before quitting.
Read-only observer: message bodies are never rendered.`, 0, 0));
      content.addChild(help);
    }
    for (const panel of MESH_TUI_PANELS) {
      if (!this.view.open[panel]) continue;
      const title2 = panel === "pids" ? "Local processes" : panel[0].toUpperCase() + panel.slice(1);
      const emptyText = panel === "agents" ? "No mesh agents" : panel === "messages" ? "No open messages" : panel === "runs" ? "No workflow runs" : "No local pid claims";
      content.addChild(dataPanel(title2, panelMetric(this.snapshot, panel), panelRows(this.snapshot, panel, theme), emptyText, theme));
    }
    if (!MESH_TUI_PANELS.some((panel) => this.view.open[panel])) {
      const empty = new Box(1, 1, theme.panelBg);
      empty.addChild(new Text(theme.dim("No panels visible. Choose one from the panel list or press 1\u20134."), 0, 0));
      content.addChild(empty);
    }
    const main = new HStack([
      { component: sidebar, basis: 28, shrink: 0, minSize: 28, visible: ({ width }) => width >= 76 },
      { component: this.scrollView, grow: 1, shrink: 1, minSize: 28 }
    ], { gap: 1 });
    const error = this.snapshot.error ? `  ${theme.error(`ERROR ${this.snapshot.error}`)}` : "";
    const wideFooter = new TruncatedText(`${theme.dim("\u2191\u2193 panels \xB7 enter/space toggle \xB7 PgUp/PgDn scroll \xB7 1\u20134 reveal \xB7 h help \xB7 q quit \xB7 live presence")}${error}`, 1, 0);
    const narrowFooter = new TruncatedText(`${theme.dim("1\u20134 reveal \xB7 \u2191\u2193 scroll \xB7 h help \xB7 q quit \xB7 live presence")}${error}`, 1, 0);
    const compactPanels = new TruncatedText(
      MESH_TUI_PANELS.map((panel, index) => `${index + 1} ${panel}:${this.view.open[panel] ? "on" : "off"}`).join("  "),
      1,
      0
    );
    this.root.clear();
    this.root.addChild(header, { basis: "auto", shrink: 0 });
    this.root.addChild(compactPanels, { basis: "auto", shrink: 0, visible: ({ width }) => width < 76 });
    this.root.addChild(main, { basis: "auto", grow: 1, shrink: 1, minSize: 1 });
    this.root.addChild(wideFooter, { basis: "auto", shrink: 0, visible: ({ width }) => width >= 76 });
    this.root.addChild(narrowFooter, { basis: "auto", shrink: 0, visible: ({ width }) => width < 76 });
  }
  handleInput(data) {
    const viewport = this.scrollView.viewportHeight;
    const page = viewport > 3 ? viewport - 2 : 10;
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
      this.scrollView.scrollBy(-page);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
      this.scrollView.scrollBy(page);
      this.requestRender();
      return;
    }
    if (this.getWidth() < 76 && (matchesKey(data, Key.up) || matchesKey(data, Key.down))) {
      this.scrollView.scrollBy(matchesKey(data, Key.up) ? -1 : 1);
      this.requestRender();
      return;
    }
    const next = applyMeshTuiKey(this.view, data);
    if (next === "quit") {
      this.onQuit();
      return;
    }
    if (next !== this.view) {
      this.view = next;
      this.rebuild();
      this.requestRender();
    }
  }
  invalidate() {
    this.root.invalidate();
  }
  render(width) {
    return this.root.render(width);
  }
};
function renderMeshTui(snapshot, view = defaultMeshTuiView(), width = 120) {
  const dashboard = new MeshDashboard(snapshot, view, false, () => void 0, () => void 0);
  return `${dashboard.render(width).map(stripTerminalSequences).join("\n")}
`;
}
async function readJson(response) {
  return await response.json();
}
async function waitForReconnect(signal, milliseconds = 1e3) {
  if (signal.aborted) return;
  await new Promise((resolve4) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve4();
    };
    const timer = setTimeout(done, milliseconds);
    timer.unref();
    signal.addEventListener("abort", done, { once: true });
  });
}
async function runMeshTui(input) {
  const base = input.serverUrl.replace(/\/$/, "");
  const headers = (identity2) => ({
    "content-type": "application/json",
    ...input.authToken ? { authorization: `Bearer ${input.authToken}` } : {},
    ...identity2 ? { "x-mesh-agent-id": identity2.id, "x-mesh-agent-key": identity2.key } : {}
  });
  const tty = input.isTty ?? Boolean(input.stdin?.isTTY && process.stdout.isTTY);
  let identity;
  let interactive;
  const name = `kxm-tui-${process.pid}`;
  const view = defaultMeshTuiView();
  const paint = (snapshot) => {
    if (interactive) {
      interactive.dashboard.update(snapshot);
      return;
    }
    input.stdout(renderMeshTui(snapshot, view));
  };
  const snapshotFromHub = async (transport, extra) => {
    const fetchedAt = (input.now?.() ?? /* @__PURE__ */ new Date()).toISOString();
    let healthOk = false;
    let readyOk = false;
    let storage;
    let onlineCount = 0;
    let error;
    try {
      const health = await input.fetchImpl(`${base}/health`);
      const body = await readJson(health);
      healthOk = health.ok && body.ok === true;
      onlineCount = Number.isInteger(body.agents) ? body.agents : 0;
    } catch {
      error = "hub_unreachable";
    }
    try {
      const ready = await input.fetchImpl(`${base}/ready`);
      const body = await readJson(ready);
      readyOk = ready.ok && body.ok === true;
      storage = body.storage;
    } catch {
      error = error ?? "hub_unreachable";
    }
    let local = loadLocalMeshSnapshot(input.dataPath, input.stateDir);
    if (identity) {
      try {
        const listed = await input.fetchImpl(`${base}/v1/agents`, { headers: headers(identity) });
        if (listed.ok) {
          const body = await readJson(listed);
          const byId = new Map(local.agents.map((agent) => [agent.id, agent]));
          for (const agent of body.agents) byId.set(agent.id, agent);
          local = {
            ...local,
            agents: [...byId.values()].sort((a, b2) => Number(b2.online) - Number(a.online) || a.name.localeCompare(b2.name))
          };
        }
      } catch {
        error = error ?? "agents_unreachable";
      }
    }
    return {
      serverUrl: input.serverUrl,
      healthOk,
      readyOk,
      ...storage ? { storage } : {},
      onlineCount,
      transport,
      fetchedAt,
      ...error ? { error } : {},
      ...local,
      ...extra
    };
  };
  const unregister = async () => {
    if (!identity) return;
    const registeredIdentity = identity;
    identity = void 0;
    await input.fetchImpl(`${base}/v1/agents/${encodeURIComponent(registeredIdentity.id)}`, {
      method: "DELETE",
      headers: headers(registeredIdentity)
    }).catch(() => void 0);
  };
  try {
    const registration = await input.fetchImpl(`${base}/v1/agents/register`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        name,
        purpose: "Read-only mesh observer TUI",
        project: input.project,
        model: "kxm-tui"
      })
    });
    if (!registration.ok) {
      const failed = await snapshotFromHub("snapshot", { error: `register_http_${registration.status}` });
      paint(failed);
      return 1;
    }
    const registered = await readJson(registration);
    identity = { id: registered.agent.id, key: registered.agentKey };
    let snapshot = await snapshotFromHub("sse");
    if (!tty) {
      paint(snapshot);
      return snapshot.healthOk ? 0 : 1;
    }
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    input.abort?.addEventListener("abort", onAbort);
    if (input.abort?.aborted) abort.abort();
    const terminal = input.terminal ?? new ProcessTerminal();
    const tui = new TuiAltScreen(terminal, false, void 0, { mouse: true });
    const dashboard = new MeshDashboard(
      snapshot,
      view,
      process.env.NO_COLOR === void 0,
      () => tui.requestRender(),
      () => abort.abort(),
      () => terminal.columns
    );
    interactive = { tui, dashboard };
    tui.setLayoutRoot(dashboard.root);
    tui.setFocus(dashboard);
    tui.start();
    const applyPresence = (agent) => {
      const byId = new Map(snapshot.agents.map((row) => [row.id, row]));
      byId.set(agent.id, agent);
      const { error: _staleError, ...healthySnapshot } = snapshot;
      snapshot = {
        ...healthySnapshot,
        transport: "sse",
        fetchedAt: (input.now?.() ?? /* @__PURE__ */ new Date()).toISOString(),
        agents: [...byId.values()].sort((a, b2) => Number(b2.online) - Number(a.online) || a.name.localeCompare(b2.name)),
        onlineCount: [...byId.values()].filter((row) => row.online).length
      };
    };
    try {
      while (!abort.signal.aborted) {
        let events;
        try {
          events = await input.fetchImpl(`${base}/v1/events?agentId=${encodeURIComponent(identity.id)}`, {
            headers: { ...headers(identity), accept: "text/event-stream" },
            signal: abort.signal
          });
        } catch (error) {
          if (abort.signal.aborted) break;
          snapshot = await snapshotFromHub("snapshot", { error: error instanceof Error ? `sse_${error.message}` : "sse_unreachable" });
          paint(snapshot);
          await waitForReconnect(abort.signal);
          continue;
        }
        if (!events.ok || !events.body) {
          snapshot = await snapshotFromHub("snapshot", { error: `sse_http_${events.status}` });
          paint(snapshot);
          await waitForReconnect(abort.signal);
          continue;
        }
        if (snapshot.error || snapshot.transport !== "sse") {
          const { error: _staleError, ...healthySnapshot } = snapshot;
          snapshot = {
            ...healthySnapshot,
            transport: "sse",
            fetchedAt: (input.now?.() ?? /* @__PURE__ */ new Date()).toISOString()
          };
          paint(snapshot);
        }
        const reader = events.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        while (!abort.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const parts = pending.split("\n\n");
          pending = parts.pop() ?? "";
          for (const part of parts) {
            if (part.startsWith(":")) continue;
            const dataLine = part.split("\n").find((line) => line.startsWith("data:"));
            if (!dataLine) continue;
            let parsed;
            try {
              parsed = JSON.parse(dataLine.slice(5).trim());
            } catch {
              continue;
            }
            if ("type" in parsed && parsed.type === "presence") {
              applyPresence(parsed.agent);
              const local = loadLocalMeshSnapshot(input.dataPath, input.stateDir);
              snapshot = {
                ...snapshot,
                openMessages: local.openMessages,
                openMessageTotal: local.openMessageTotal,
                runs: local.runs,
                runTotal: local.runTotal,
                pids: local.pids
              };
              paint(snapshot);
            } else if ("type" in parsed && (parsed.type === "message" || parsed.type === "reply" || parsed.type === "cancelled" || parsed.type === "expired")) {
              const local = loadLocalMeshSnapshot(input.dataPath, input.stateDir);
              const { error: _staleError, ...healthySnapshot } = snapshot;
              snapshot = {
                ...healthySnapshot,
                transport: "sse",
                fetchedAt: (input.now?.() ?? /* @__PURE__ */ new Date()).toISOString(),
                openMessages: local.openMessages,
                openMessageTotal: local.openMessageTotal,
                runs: local.runs,
                runTotal: local.runTotal,
                pids: local.pids
              };
              paint(snapshot);
            }
          }
        }
        if (!abort.signal.aborted) {
          snapshot = await snapshotFromHub("snapshot", { error: "sse_reconnecting" });
          paint(snapshot);
          await waitForReconnect(abort.signal);
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    } finally {
      input.abort?.removeEventListener("abort", onAbort);
      tui.stop();
      interactive = void 0;
    }
    return 0;
  } catch (error) {
    const failed = await snapshotFromHub("snapshot", {
      error: error instanceof Error ? error.message : "tui_failed"
    });
    paint(failed);
    return 1;
  } finally {
    await unregister();
  }
}

// plugins/kxm-mesh/src/cli.ts
var CLI_NAME = "kxm";
var repoRoot = resolve3(fileURLToPath2(new URL("../../../", import.meta.url)));
var USAGE_ERROR_CODES = /* @__PURE__ */ new Set([
  "commander.help",
  "commander.helpDisplayed",
  "commander.unknownCommand",
  "commander.unknownOption",
  "commander.missingArgument",
  "commander.missingMandatoryOptionValue",
  "commander.invalidArgument",
  "commander.excessArguments",
  "commander.variadicArgNotLast",
  "commander.invalidOptionArgument",
  "commander.optionMissingArgument"
]);
function spawnScript(scriptName, extraEnv = {}) {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [join9(repoRoot, "scripts", scriptName)], {
      stdio: "inherit",
      env: { ...process.env, ...extraEnv }
    });
    child.once("error", () => resolveExit(1));
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
}
function parseEvidencePairs(values) {
  const evidence = /* @__PURE__ */ new Map();
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error("evidence must use <required-key>=<evidence> syntax");
    }
    const requirement = canonicalWorkflowEvidenceKey(value.slice(0, separator));
    const proof = value.slice(separator + 1).trim();
    if (!requirement || !proof) throw new Error("evidence must use <required-key>=<evidence> syntax");
    if (evidence.has(requirement)) throw new Error(`duplicate normalized evidence key: ${requirement}`);
    evidence.set(requirement, proof);
  }
  return Object.fromEntries(evidence);
}
function print(io, jsonMode, payload, text) {
  const safePayload = JSON.stringify(redactCliValue(payload));
  io.stdout(jsonMode ? `${safePayload}
` : `${redactSecrets(text)}
`);
}
function printWorker(runtime, worker, payload, text, outcome) {
  const sessionId = runtime.env.KXM_SESSION_ID?.trim();
  const envelope = workerResult(worker, {
    ...payload,
    summary: text,
    ...outcome ? { outcome } : {},
    ...sessionId ? { sessionId } : {}
  });
  if (!runtime.dryRun) {
    try {
      const safeEnvelope = redactCliValue(envelope);
      appendTelemetry(telemetryPath(runtime.dirs.logs), makeTelemetryEvent({
        envelope: safeEnvelope,
        ...sessionId ? { sessionId } : {},
        host: hostMode(runtime),
        target: inferImprovementTarget({
          ...worker.project ? { project: worker.project } : {},
          env: runtime.env
        })
      }));
    } catch {
    }
  }
  print(runtime.io, runtime.json, envelope, text);
}
function hostMode(runtime) {
  try {
    const hostname = new URL(runtime.serverUrl).hostname;
    if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") return "local";
  } catch {
  }
  return "mesh";
}
function gateOf(runtime, name) {
  const project = runtime.env.PI_MESH_PROJECT?.trim();
  return gateWorker({ name, ...project ? { project } : {} });
}
function redactCliValue(value, field = "") {
  if (typeof value === "string") {
    if ((field === "requestSha256" || field === "replySha256") && /^[a-f0-9]{64}$/.test(value)) return value;
    return redactSecrets(value);
  }
  if (Array.isArray(value)) return value.map((candidate) => redactCliValue(candidate));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, candidate]) => [key, redactCliValue(candidate, key)])
    );
  }
  return value;
}
function workspaceDirs(cwd, workspaceFlag, env) {
  const workdir = resolve3(env.PI_MESH_WORKDIR?.trim() || cwd);
  const workspace = resolve3(workdir, workspaceFlag || env.PI_MESH_WORKSPACE_DIR?.trim() || ".kxm");
  const derive = workspaceFlag !== void 0;
  return {
    workdir,
    workspace,
    config: derive ? join9(workspace, "config") : resolve3(workdir, env.PI_MESH_CONFIG_DIR?.trim() || join9(workspace, "config")),
    logs: derive ? join9(workspace, "logs") : resolve3(workdir, env.PI_MESH_LOGS_DIR?.trim() || join9(workspace, "logs")),
    assets: derive ? join9(workspace, "assets") : resolve3(workdir, env.PI_MESH_ASSETS_DIR?.trim() || join9(workspace, "assets")),
    state: derive ? join9(workspace, "state") : resolve3(workdir, env.PI_MESH_STATE_DIR?.trim() || join9(workspace, "state"))
  };
}
function maskEnvName(name) {
  return /TOKEN|SECRET|KEY|PASSWORD/i.test(name);
}
function redactConfiguredValues(text, env) {
  let safe = text;
  for (const [name, value] of Object.entries(env)) {
    if (!maskEnvName(name) || !value || value.length < 4) continue;
    safe = safe.replaceAll(value, "[redacted]");
  }
  const trailingNewline = safe.endsWith("\n") ? "\n" : "";
  try {
    const parsed = JSON.parse(safe);
    return `${JSON.stringify(redactCliValue(parsed))}${trailingNewline}`;
  } catch {
  }
  return redactSecrets(safe);
}
function processExists2(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
async function hubGet(url, fetchImpl) {
  try {
    const response = await fetchImpl(url);
    const text = redactSecrets((await response.text()).slice(0, 8e3));
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
    }
    return { ok: response.ok, status: response.status, body };
  } catch {
    return { ok: false, status: 0, body: { error: "hub_unreachable" } };
  }
}
function localWorkflowSnapshot(dataPath, runId) {
  if (!existsSync3(dataPath)) throw new Error("state_database_not_found");
  const database = new DatabaseSync2(dataPath, { readOnly: true });
  try {
    const rows = runId ? database.prepare("SELECT record FROM workflow_runs WHERE id = ?").all(runId) : database.prepare("SELECT record FROM workflow_runs ORDER BY rowid DESC LIMIT 200").all();
    const runs = rows.map((row) => JSON.parse(row.record));
    const journal = runId ? database.prepare("SELECT record FROM workflow_journal WHERE run_id = ? ORDER BY rowid").all(runId).map((row) => JSON.parse(row.record)) : [];
    return { runs, journal };
  } finally {
    database.close();
  }
}
async function postWorkflowStart(input) {
  const payload = input.event && input.payload.event === void 0 ? { ...input.payload, event: input.event } : input.payload;
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac2("sha256", input.secret).update(body).digest("hex")}`;
  const response = await input.fetchImpl(`${input.serverUrl.replace(/\/$/, "")}/v1/webhooks/${encodeURIComponent(input.definitionId)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature, "x-mesh-delivery-id": input.deliveryId, ...input.event ? { "x-github-event": input.event } : {} },
    body
  });
  const responseText = (await response.text()).slice(0, 8e3);
  let parsed = {};
  try {
    parsed = JSON.parse(responseText);
  } catch {
  }
  if (!response.ok) throw new Error(`workflow_start_http_${response.status}`);
  return { status: response.status, ...parsed.run?.id ? { runId: parsed.run.id } : {}, duplicate: parsed.duplicate === true };
}
async function postWorkflowDegradation(input) {
  const response = await input.fetchImpl(
    `${input.serverUrl.replace(/\/$/, "")}/v1/workflows/${encodeURIComponent(input.runId)}/degradations`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.authToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        stageId: input.stageId,
        requirementKey: input.requirementKey,
        reason: input.reason
      })
    }
  );
  const text = (await response.text()).slice(0, 8e3);
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
  }
  if (!response.ok) throw new Error(`workflow_degradation_http_${response.status}`);
  return {
    status: response.status,
    duplicate: parsed.duplicate === true,
    ...parsed.approval?.id ? { approvalId: parsed.approval.id } : {}
  };
}
function addGlobalOptions(command) {
  return command.option("--json", "Print machine-readable JSON").option("--dry-run", "Plan without making changes").option("--workspace <dir>", "Workspace directory");
}
function runtimeFrom(ctx, command) {
  const opts = command.optsWithGlobals();
  return {
    ...ctx,
    json: Boolean(opts.json),
    dryRun: Boolean(opts.dryRun),
    dirs: workspaceDirs(ctx.cwd, opts.workspace, ctx.env),
    serverUrl: ctx.env.PI_MESH_SERVER_URL?.trim() || "http://127.0.0.1:7331",
    fetchImpl: ctx.io.fetchImpl ?? fetch
  };
}
function workspaceEnv(runtime) {
  return {
    PI_MESH_WORKDIR: runtime.dirs.workdir,
    PI_MESH_WORKSPACE_DIR: runtime.dirs.workspace,
    PI_MESH_CONFIG_DIR: runtime.dirs.config,
    PI_MESH_LOGS_DIR: runtime.dirs.logs,
    PI_MESH_ASSETS_DIR: runtime.dirs.assets,
    PI_MESH_STATE_DIR: runtime.dirs.state
  };
}
function activeWorkflowDefinition(runtime, definitionId) {
  const inline = runtime.env.PI_MESH_WEBHOOK_WORKFLOWS?.trim();
  const file = runtime.env.PI_MESH_WEBHOOK_WORKFLOWS_FILE?.trim();
  if (inline && file) {
    throw new Error("configure only one of PI_MESH_WEBHOOK_WORKFLOWS or PI_MESH_WEBHOOK_WORKFLOWS_FILE");
  }
  if (!inline && !file) return void 0;
  let raw;
  if (file) {
    try {
      raw = readFileSync4(resolve3(runtime.cwd, file), "utf8");
    } catch {
      throw new Error("workflow definition file is unavailable");
    }
  } else {
    raw = inline;
  }
  const definition = parseWorkflowDefinitions(raw, runtime.env).find((candidate) => candidate.id === definitionId);
  if (!definition) throw new Error(`workflow definition not found: ${definitionId}`);
  return definition;
}
function workflowCredential(runtime, definitionId, kind) {
  const definition = activeWorkflowDefinition(runtime, definitionId);
  if (definition) return kind === "start" ? definition.secret : definition.signalSecret ?? definition.secret;
  return kind === "start" ? runtime.env.PI_MESH_WORKFLOW_SECRET?.trim() : runtime.env.PI_MESH_WORKFLOW_SIGNAL_SECRET?.trim();
}
function reportWorkflowConfigError(runtime, error) {
  const message = error instanceof Error ? redactSecrets(error.message) : "invalid workflow configuration";
  runtime.io.stderr(`${message}
`);
  return 2;
}
async function cmdInit(runtime) {
  const created = [];
  for (const directory of [runtime.dirs.config, runtime.dirs.logs, runtime.dirs.assets, runtime.dirs.state, ...standardAssetDirs(runtime.dirs.assets)]) {
    if (runtime.dryRun) created.push(directory);
    else {
      mkdirSync5(directory, { recursive: true });
      created.push(directory);
    }
  }
  const templateConfig = join9(repoRoot, ".kxm", "config");
  if (!runtime.dryRun && existsSync3(templateConfig)) cpSync(templateConfig, runtime.dirs.config, { recursive: true, force: false, errorOnExist: false });
  print(runtime.io, runtime.json, { ok: true, command: "init", created, templates: existsSync3(templateConfig) }, `initialized ${runtime.dirs.workspace}`);
  return 0;
}
async function cmdValidate(runtime, fileFlag) {
  const worker = gateOf(runtime, "validate");
  const explicitFile = fileFlag?.trim();
  const configuredFile = runtime.env.PI_MESH_WEBHOOK_WORKFLOWS_FILE?.trim();
  const inline = runtime.env.PI_MESH_WEBHOOK_WORKFLOWS?.trim();
  if (!explicitFile && configuredFile && inline) {
    printWorker(
      runtime,
      worker,
      { ok: false, command: "validate", error: "ambiguous_workflow_source" },
      "configure only one of PI_MESH_WEBHOOK_WORKFLOWS or PI_MESH_WEBHOOK_WORKFLOWS_FILE"
    );
    return 2;
  }
  if (!explicitFile && !configuredFile && !inline) {
    printWorker(
      runtime,
      worker,
      { ok: false, command: "validate", error: "workflow_source_required" },
      "provide --file or configure exactly one workflow source environment variable"
    );
    return 2;
  }
  const selectedFile = explicitFile || configuredFile;
  const file = selectedFile ? resolve3(runtime.cwd, selectedFile) : void 0;
  if (file && !existsSync3(file)) {
    printWorker(runtime, worker, { ok: false, command: "validate", error: "file_not_found", file }, `workflow file not found: ${file}`);
    return 1;
  }
  try {
    const raw = file ? readFileSync4(file, "utf8") : inline;
    const warnings = [];
    const definitions = parseWorkflowDefinitions(raw, runtime.env, (message) => warnings.push(message));
    const secretEnvs = definitions.map((definition) => ({
      id: definition.id,
      secretConfigured: Boolean(definition.secret),
      signalSecretConfigured: Boolean(definition.signalSecret)
    }));
    const source = file ? "file" : "inline";
    printWorker(
      runtime,
      worker,
      { ok: true, command: "validate", source, ...file ? { file } : {}, workflows: secretEnvs, warnings },
      `validated ${definitions.length} workflow(s) from ${source}${warnings.length ? ` with ${warnings.length} warning(s)` : ""}`,
      warnings.length ? "warning" : void 0
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? redactSecrets(error.message) : "invalid_workflow";
    printWorker(runtime, worker, { ok: false, command: "validate", error: message }, message);
    return 1;
  }
}
async function cmdArtifactsExist(runtime, pathFlag) {
  const worker = gateOf(runtime, "artifacts-exist");
  const checked = verifyArtifactExists(runtime.dirs.assets, resolve3(runtime.cwd, pathFlag));
  if (!checked.ok) {
    printWorker(
      runtime,
      worker,
      { ok: false, command: "artifacts-exist", error: checked.error, path: checked.path },
      `artifact verification failed: ${checked.error}`
    );
    return 1;
  }
  printWorker(
    runtime,
    worker,
    { ok: true, command: "artifacts-exist", path: checked.path, bytes: checked.bytes },
    "artifact exists and is non-empty under workspace assets"
  );
  return 0;
}
async function cmdStatus(runtime) {
  const health = await hubGet(`${runtime.serverUrl}/health`, runtime.fetchImpl);
  const ready = await hubGet(`${runtime.serverUrl}/ready`, runtime.fetchImpl);
  const payload = { ok: health.ok && ready.ok, command: "status", health: health.body, ready: ready.body };
  print(runtime.io, runtime.json, payload, `hub health=${health.ok} ready=${ready.ok}`);
  return payload.ok ? 0 : 1;
}
async function cmdMeshTui(runtime) {
  const dataPath = resolve3(runtime.dirs.workdir, runtime.env.PI_MESH_DATA_PATH?.trim() || join9(runtime.dirs.state, "mesh.db"));
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, {
      ok: true,
      command: "tui",
      dryRun: true,
      serverUrl: runtime.serverUrl,
      transport: "sse"
    }, "would start mesh tui (SSE observer)");
    return 0;
  }
  if (runtime.json) {
    runtime.io.stderr("mesh tui does not support --json; use mesh status\n");
    return 2;
  }
  const project = runtime.env.PI_MESH_PROJECT?.trim() || "payk12";
  const authToken = runtime.env.PI_MESH_AUTH_TOKEN?.trim();
  return await runMeshTui({
    serverUrl: runtime.serverUrl,
    dataPath,
    stateDir: runtime.dirs.state,
    project,
    ...authToken ? { authToken } : {},
    fetchImpl: runtime.fetchImpl,
    stdout: runtime.io.stdout,
    stdin: process.stdin,
    isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY)
  });
}
async function cmdHub(runtime) {
  const extraEnv = workspaceEnv(runtime);
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, { ok: true, command: "hub", dryRun: true, workspace: runtime.dirs.workspace }, "would start hub");
    return 0;
  }
  return await (runtime.io.spawnHub ?? ((launchEnv) => spawnScript("pi-mesh-hub.mjs", launchEnv)))(extraEnv);
}
async function cmdWorker(runtime, options) {
  const name = options.name?.trim() || runtime.env.PI_MESH_AGENT_NAME?.trim();
  const project = options.project?.trim() || runtime.env.PI_MESH_PROJECT?.trim();
  const model = options.model?.trim() || runtime.env.PI_MESH_WORKER_MODEL?.trim();
  const fallbackModels = options.fallbackModels?.trim() || runtime.env.PI_MESH_WORKER_FALLBACK_MODELS?.trim();
  const tools = options.tools?.trim() || runtime.env.PI_MESH_WORKER_TOOLS?.trim();
  const extraEnv = {
    ...workspaceEnv(runtime),
    ...name ? { PI_MESH_AGENT_NAME: name } : {},
    ...project ? { PI_MESH_PROJECT: project } : {},
    ...model ? { PI_MESH_WORKER_MODEL: model } : {},
    ...fallbackModels ? { PI_MESH_WORKER_FALLBACK_MODELS: fallbackModels } : {},
    ...tools ? { PI_MESH_WORKER_TOOLS: tools } : {},
    ...options.continue === false ? { PI_MESH_WORKER_CONTINUE: "false" } : {},
    ...options.freshStart ? { PI_MESH_WORKER_INITIAL_CONTINUE: "false" } : {}
  };
  if (runtime.dryRun) {
    printWorker(runtime, agentWorker({
      name: name || "required",
      project: project || "required",
      ...model ? { model } : {}
    }), {
      ok: true,
      command: "worker",
      dryRun: true,
      workspace: runtime.dirs.workspace,
      name: name || "required",
      project: project || "required",
      model: model || "provider default",
      fallbackModels: fallbackModels || "none",
      tools: tools || "Pi defaults",
      continue: options.continue !== false,
      freshStart: Boolean(options.freshStart)
    }, "would start worker");
    return 0;
  }
  if (!name || !project) {
    runtime.io.stderr("worker requires --name and --project (or PI_MESH_AGENT_NAME and PI_MESH_PROJECT)\n");
    return 2;
  }
  return await (runtime.io.spawnWorker ?? ((launchEnv) => spawnScript("pi-mesh-worker.mjs", launchEnv)))(extraEnv);
}
async function cmdStop(runtime, waitMsFlag) {
  const pids = existsSync3(runtime.dirs.state) ? readdirSync2(runtime.dirs.state).filter((name) => name.endsWith(".pid")) : [];
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, { ok: true, command: "stop", dryRun: true, pidFiles: pids }, "would signal pid files");
    return 0;
  }
  if (pids.length === 0) {
    print(runtime.io, runtime.json, { ok: false, command: "stop", error: "no_pid_files" }, "no hub/worker pid files found");
    return 1;
  }
  const requested = [];
  const ignored = [];
  const records = /* @__PURE__ */ new Map();
  for (const file of pids) {
    try {
      const record = JSON.parse(readFileSync4(join9(runtime.dirs.state, file), "utf8"));
      const expectedControl = file === "hub.pid" ? "hub.stop" : file.startsWith("worker-") ? `${file.slice(0, -4)}.stop` : void 0;
      const expectedRole = file === "hub.pid" ? "hub" : file.startsWith("worker-") ? "worker" : void 0;
      if (record.version !== 1 || !Number.isInteger(record.pid) || record.pid <= 0 || !record.startedAt || !expectedControl || record.controlFile !== expectedControl || record.role !== expectedRole || !processExists2(record.pid)) {
        ignored.push(file);
        continue;
      }
      writeFileSync4(join9(runtime.dirs.state, record.controlFile), `${JSON.stringify({ startedAt: record.startedAt, ...record.generation ? { generation: record.generation } : {}, requestedAt: (/* @__PURE__ */ new Date()).toISOString() })}
`, { encoding: "utf8", mode: 384 });
      requested.push(file);
      records.set(file, { pid: record.pid, startedAt: record.startedAt, ...record.generation ? { generation: record.generation } : {} });
    } catch {
      ignored.push(file);
    }
  }
  if (requested.length === 0) {
    print(runtime.io, runtime.json, { ok: false, command: "stop", requested, ignored }, "no current managed processes found");
    return 1;
  }
  const waitMs = Math.min(3e4, Math.max(100, Number(waitMsFlag || 5e3)));
  const deadline = Date.now() + waitMs;
  const stopped = /* @__PURE__ */ new Set();
  while (Date.now() <= deadline && stopped.size < requested.length) {
    for (const [file, record] of records) {
      try {
        const current = JSON.parse(readFileSync4(join9(runtime.dirs.state, file), "utf8"));
        if (current.pid !== record.pid || current.startedAt !== record.startedAt || current.generation !== record.generation || !processExists2(record.pid)) stopped.add(file);
      } catch {
        stopped.add(file);
      }
    }
    if (stopped.size < requested.length) await (runtime.io.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))))(100);
  }
  const timedOut = requested.filter((file) => !stopped.has(file));
  const ok = timedOut.length === 0;
  print(runtime.io, runtime.json, { ok, command: "stop", requested, stopped: [...stopped], timedOut, ignored }, ok ? "managed processes stopped" : "stop request timed out");
  return ok ? 0 : 1;
}
async function cmdSessionStatus(runtime) {
  const stateDir = runtime.dirs.state;
  const names = existsSync3(stateDir) ? readdirSync2(stateDir) : [];
  const claims = [];
  for (const file of names.filter((name) => name.endsWith(".pid"))) {
    try {
      const record = JSON.parse(readFileSync4(join9(stateDir, file), "utf8"));
      claims.push({
        file,
        role: record.role,
        pid: record.pid,
        startedAt: record.startedAt,
        live: Number.isInteger(record.pid) && record.pid > 0 && processExists2(record.pid)
      });
    } catch {
      claims.push({ file, live: false, error: "invalid_pid_record" });
    }
  }
  const recoveries = [];
  for (const file of names.filter((name) => name.startsWith("worker-recovery-") && name.endsWith(".json"))) {
    try {
      const envelope = JSON.parse(readFileSync4(join9(stateDir, file), "utf8"));
      recoveries.push({
        file,
        reason: envelope.reason,
        agentName: envelope.agentName,
        project: envelope.project,
        createdAt: envelope.createdAt,
        runId: envelope.runId ?? void 0,
        stageId: envelope.stageId ?? void 0,
        freshSession: envelope.freshSession === true
      });
    } catch {
      recoveries.push({ file, error: "invalid_recovery_envelope" });
    }
  }
  print(
    runtime.io,
    runtime.json,
    { ok: true, command: "session status", claims, recoveries },
    `${claims.length} session claim(s), ${recoveries.length} recovery envelope(s)`
  );
  return 0;
}
async function cmdSessionStart(runtime, options) {
  const id = options.id?.trim() || `session_${randomUUID2().replaceAll("-", "").slice(0, 12)}`;
  const workflowId = options.workflow?.trim();
  const mix = options.mix?.trim();
  if (workflowId && mix) {
    runtime.io.stderr("session start takes --workflow or --mix, not both\n");
    return 2;
  }
  if (!workflowId && !mix) {
    runtime.io.stderr("session start requires --workflow <id> or --mix <agent,gate,...>\n");
    return 2;
  }
  const project = runtime.env.PI_MESH_PROJECT?.trim();
  let workers;
  try {
    const names = mix ? mix.split(",").map((name) => name.trim()).filter(Boolean) : rosterNames(runtime.dirs.config);
    workers = loadNamedWorkers(runtime.dirs.config, names, project);
  } catch (error) {
    const errorName = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    if (errorName !== "SessionConfigError") throw error;
    const message = error instanceof Error ? redactSecrets(error.message) : "invalid session configuration";
    runtime.io.stderr(`${message}
`);
    return 2;
  }
  const session = createSession({
    id,
    host: hostMode(runtime),
    mode: workflowId ? "workflow" : "mix",
    workers,
    assetsDir: runtime.dirs.assets,
    ...workflowId ? { workflowId } : {}
  });
  const created = [
    ...sessionAssetDirs(runtime.dirs.assets, session.id),
    ...workflowId ? workflowAssetDirs(runtime.dirs.assets, workflowId) : []
  ];
  if (!runtime.dryRun) {
    for (const directory of created) mkdirSync5(directory, { recursive: true });
    writeSession(runtime.dirs.assets, session);
  }
  print(runtime.io, runtime.json, {
    ok: true,
    command: "session start",
    dryRun: runtime.dryRun || void 0,
    session,
    created
  }, `session ${session.id} (${session.mode})`);
  return 0;
}
async function cmdImprove(runtime, targetFlag) {
  const targets = targetFlag === "cli" || targetFlag === "project" ? [targetFlag] : ["cli", "project"];
  const events = readTelemetry(telemetryPath(runtime.dirs.logs));
  const report = buildImprovementReport(events, targets);
  const path5 = writeImprovementReport(join9(runtime.dirs.assets, "improvements"), report, runtime.dryRun);
  print(runtime.io, runtime.json, {
    ok: true,
    command: "improve",
    dryRun: runtime.dryRun || void 0,
    path: path5,
    events: report.events,
    proposals: report.proposals.length,
    report
  }, `proposed ${report.proposals.length} improvement(s) from ${report.events} event(s)`);
  return 0;
}
async function cmdWorkflowStart(runtime, definitionIdArg, options) {
  const definitionId = definitionIdArg || runtime.env.PI_MESH_WORKFLOW_ID?.trim();
  const deliveryId = String(options.deliveryId || `cli-${randomUUID2()}`);
  const event = options.event;
  const payloadFlag = options.payload ?? "{}";
  if (!definitionId) {
    runtime.io.stderr("workflow start requires <definitionId> (or PI_MESH_WORKFLOW_ID)\n");
    return 2;
  }
  let secret;
  try {
    secret = workflowCredential(runtime, definitionId, "start");
  } catch (error) {
    return reportWorkflowConfigError(runtime, error);
  }
  if (!secret) {
    runtime.io.stderr("workflow start requires PI_MESH_WORKFLOW_SECRET when no active definition source is configured\n");
    return 2;
  }
  let payload;
  try {
    const raw = payloadFlag.startsWith("@") ? readFileSync4(resolve3(runtime.cwd, payloadFlag.slice(1)), "utf8") : payloadFlag;
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    payload = value;
  } catch {
    print(runtime.io, runtime.json, { ok: false, command: "workflow start", error: "invalid_payload" }, "workflow payload must be a JSON object or @file");
    return 2;
  }
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, { ok: true, command: "workflow start", dryRun: true, definitionId, deliveryId, event }, "would POST a signed workflow webhook");
    return 0;
  }
  try {
    const response = await postWorkflowStart({ serverUrl: runtime.serverUrl, definitionId, secret, deliveryId, ...event ? { event } : {}, payload, fetchImpl: runtime.fetchImpl });
    print(runtime.io, runtime.json, { ok: true, command: "workflow start", definitionId, deliveryId, ...response }, `started workflow ${response.runId ?? "accepted"}`);
    return 0;
  } catch {
    print(runtime.io, runtime.json, { ok: false, command: "workflow start", error: "workflow_start_failed" }, "signed workflow start failed");
    return 1;
  }
}
async function cmdWorkflowDegrade(runtime, runId, stageId, options) {
  const requirementKey = options.requirement?.trim() ?? "";
  const reason = options.reason?.trim() ?? "";
  const adminToken = runtime.env.PI_MESH_AUTH_TOKEN?.trim();
  if (!runId || !stageId || !requirementKey || !reason || !adminToken) {
    runtime.io.stderr("workflow degrade requires <runId> <stageId>, --requirement, --reason, and PI_MESH_AUTH_TOKEN\n");
    return 2;
  }
  const worker = gateOf(runtime, "degrade");
  if (runtime.dryRun) {
    printWorker(
      runtime,
      worker,
      { ok: true, command: "workflow degrade", dryRun: true, runId, stageId, requirementKey },
      `would approve configured degraded quorum for ${runId}/${stageId}/${requirementKey}`
    );
    return 0;
  }
  try {
    const result = await postWorkflowDegradation({
      serverUrl: runtime.serverUrl,
      authToken: adminToken,
      runId,
      stageId,
      requirementKey,
      reason,
      fetchImpl: runtime.fetchImpl
    });
    printWorker(
      runtime,
      worker,
      { ok: true, command: "workflow degrade", runId, stageId, requirementKey, ...result },
      result.duplicate ? "degraded quorum was already approved" : "approved configured degraded quorum"
    );
    return 0;
  } catch {
    printWorker(
      runtime,
      worker,
      { ok: false, command: "workflow degrade", error: "workflow_degradation_failed", runId, stageId, requirementKey },
      "workflow degradation approval failed"
    );
    return 1;
  }
}
async function cmdWorkflowInspect(runtime, action, runId) {
  const dataPath = resolve3(runtime.dirs.workdir, runtime.env.PI_MESH_DATA_PATH?.trim() || join9(runtime.dirs.state, "mesh.db"));
  if (action === "get" && !runId) {
    runtime.io.stderr(`Usage: ${CLI_NAME} workflow get <runId>
`);
    return 2;
  }
  try {
    const snapshot = localWorkflowSnapshot(dataPath, runId);
    if (runId && snapshot.runs.length === 0) {
      print(runtime.io, runtime.json, { ok: false, command: "workflow get", error: "workflow_not_found" }, "workflow not found");
      return 1;
    }
    const value = action === "get" ? { ok: true, command: "workflow get", run: snapshot.runs[0], journal: snapshot.journal } : { ok: true, command: "workflow list", runs: snapshot.runs };
    print(runtime.io, runtime.json, value, action === "get" ? `workflow ${runId}` : `${snapshot.runs.length} workflow(s)`);
    return 0;
  } catch {
    print(runtime.io, runtime.json, { ok: false, command: `workflow ${action}`, error: "state_unavailable" }, "local workflow state is unavailable");
    return 1;
  }
}
async function cmdSignal(runtime, runId, signalKey, status, summary, evidenceArgs, deliveryIdFlag) {
  if (!runId || !signalKey || !status || !summary) {
    runtime.io.stderr(`Usage: ${CLI_NAME} gate signal <runId> <signalKey> <passed|warning|failed> <summary> [<required-key>=<evidence> ...]
`);
    return 2;
  }
  if (status !== "passed" && status !== "warning" && status !== "failed") {
    runtime.io.stderr("status must be passed, warning, or failed\n");
    return 2;
  }
  let evidence;
  try {
    evidence = parseEvidencePairs(evidenceArgs);
  } catch (error) {
    runtime.io.stderr(`${error instanceof Error ? error.message : "invalid evidence"}
`);
    return 2;
  }
  const definitionId = runtime.env.PI_MESH_WORKFLOW_ID?.trim();
  if (!definitionId) {
    runtime.io.stderr("signal requires PI_MESH_WORKFLOW_ID\n");
    return 2;
  }
  let signalSecret;
  try {
    signalSecret = workflowCredential(runtime, definitionId, "signal");
  } catch (error) {
    return reportWorkflowConfigError(runtime, error);
  }
  if (!signalSecret) {
    runtime.io.stderr("signal requires PI_MESH_WORKFLOW_SIGNAL_SECRET when no active definition source is configured\n");
    return 2;
  }
  const worker = gateOf(runtime, "signal");
  if (runtime.dryRun) {
    printWorker(runtime, worker, { ok: true, command: "signal", runId, signalKey, status, summary, evidence }, "would post signed signal");
    return 0;
  }
  const deliveryId = String(deliveryIdFlag || `cli-signal:${randomUUID2()}`);
  try {
    const posted = await postWorkflowSignal({
      serverUrl: runtime.serverUrl,
      definitionId,
      signalSecret,
      runId,
      signalKey,
      status,
      summary,
      evidence,
      deliveryId,
      fetchImpl: runtime.fetchImpl
    });
    printWorker(runtime, worker, { ok: true, command: "signal", duplicate: posted.duplicate, deliveryId }, "posted signed signal");
    return 0;
  } catch {
    printWorker(runtime, worker, { ok: false, command: "signal", error: "signal_failed", deliveryId }, "signed signal failed");
    return 1;
  }
}
async function cmdGithubWatch(runtime, options) {
  const token = runtime.env.GITHUB_TOKEN?.trim() || runtime.env.GH_TOKEN?.trim();
  const definitionId = runtime.env.PI_MESH_WORKFLOW_ID?.trim();
  const runId = String(options.runId || "");
  const stageId = String(options.stageId || "");
  const signalKey = String(options.signalKey || "");
  const repo = String(options.repo || "");
  const pr = Number(options.pr);
  if (!definitionId || !runId || !stageId || !signalKey || !repo || !Number.isInteger(pr)) {
    runtime.io.stderr("github watch requires PI_MESH_WORKFLOW_ID, --run-id, --stage-id, --signal-key, --repo, --pr\n");
    return 2;
  }
  let signalSecret;
  try {
    signalSecret = workflowCredential(runtime, definitionId, "signal");
  } catch (error) {
    return reportWorkflowConfigError(runtime, error);
  }
  if (!signalSecret) {
    runtime.io.stderr("github watch requires PI_MESH_WORKFLOW_SIGNAL_SECRET when no active definition source is configured\n");
    return 2;
  }
  const result = await watchGithubChecks({
    serverUrl: runtime.serverUrl,
    definitionId,
    signalSecret,
    runId,
    stageId,
    signalKey,
    repo,
    pr,
    required: options.required ? [...new Set(String(options.required).split(",").map((name) => name.trim()).filter(Boolean))] : [],
    timeoutMs: Number(options.timeoutMs || 18e5),
    intervalMs: Number(options.intervalMs || 15e3),
    ...options.deliveryId ? { deliveryId: options.deliveryId } : {},
    ...token ? { token } : {},
    dryRun: runtime.dryRun,
    fetchImpl: runtime.fetchImpl,
    ...runtime.io.now ? { now: runtime.io.now } : {},
    ...runtime.io.sleep ? { sleep: runtime.io.sleep } : {}
  });
  const worker = gateOf(runtime, "github-watch");
  const payload = {
    ok: result.exitCode === 0,
    command: "github watch",
    posted: result.posted,
    status: result.status,
    summary: result.summary,
    evidence: result.evidence,
    deliveryId: result.deliveryId,
    skipped: result.skipped
  };
  const outcome = result.exitCode === 0 ? result.status === "warning" ? "warning" : "passed" : "failed";
  if (JSON.stringify(payload).includes(token ?? "___never___") || Object.keys(runtime.env).some((key) => maskEnvName(key) && JSON.stringify(payload).includes(String(runtime.env[key])))) {
    printWorker(runtime, worker, { ok: false, command: "github watch", error: "redaction_failure" }, "refusing to print a payload that contains a secret");
    return 1;
  }
  printWorker(runtime, worker, payload, result.summary, outcome);
  return result.exitCode;
}
async function cmdRetrospectiveExport(runtime, runId, options) {
  if (!runId) {
    runtime.io.stderr(`Usage: ${CLI_NAME} workflow export <runId>
`);
    return 2;
  }
  const snapshotFlag = String(options.input || "");
  const snapshotPath = snapshotFlag ? resolve3(runtime.cwd, snapshotFlag) : "";
  let snapshot;
  try {
    if (snapshotPath) {
      if (!existsSync3(snapshotPath)) throw new Error("snapshot_missing");
      snapshot = JSON.parse(readFileSync4(snapshotPath, "utf8"));
    } else {
      const dataPath = resolve3(runtime.dirs.workdir, runtime.env.PI_MESH_DATA_PATH?.trim() || join9(runtime.dirs.state, "mesh.db"));
      const local = localWorkflowSnapshot(dataPath, runId);
      if (!local.runs[0]) throw new Error("workflow_not_found");
      snapshot = { run: local.runs[0], journal: local.journal };
    }
    if (snapshot.run.id !== runId) throw new Error("run_id_mismatch");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "snapshot_invalid";
    print(runtime.io, runtime.json, { ok: false, command: "retrospective export", error: reason }, "retrospective source is invalid or unavailable");
    return 1;
  }
  const doc = buildRetrospective(snapshot.run, snapshot.journal);
  const outDir = resolve3(runtime.cwd, String(options.outDir || join9(runtime.dirs.assets, "retrospectives")));
  const assetsRoot = resolve3(runtime.dirs.assets);
  const assetsPrefix = `${assetsRoot}${process.platform === "win32" ? "\\" : "/"}`;
  if (outDir !== assetsRoot && !outDir.startsWith(assetsPrefix)) {
    print(runtime.io, runtime.json, { ok: false, command: "retrospective export", error: "output_outside_workspace_assets" }, "retrospectives must stay under the workspace assets directory");
    return 2;
  }
  if (runtime.dryRun) {
    print(runtime.io, runtime.json, { ok: true, command: "retrospective export", dryRun: true, runId: doc.runId }, `would export ${doc.runId}`);
    return 0;
  }
  const written = writeRetrospective(outDir, doc);
  print(runtime.io, runtime.json, { ok: true, command: "retrospective export", ...written, reviewDecision: doc.reviewDecision }, `exported ${written.jsonPath}`);
  return 0;
}
async function cmdSmoke(runtime, realPi) {
  if (runtime.env.PI_MESH_SMOKE !== "1" && !realPi) {
    print(runtime.io, runtime.json, { ok: true, skipped: true, reason: "PI_MESH_SMOKE is not 1" }, "smoke skipped");
    return 0;
  }
  return await spawnScript("smoke-multi-pi.mjs", { PI_MESH_SMOKE: "1", ...workspaceEnv(runtime) });
}
function createProgram(ctx, result) {
  const bind = (action) => {
    return async function commandAction(...args) {
      const command = args.at(-1) instanceof Command ? args.at(-1) : this;
      result.code = await action(runtimeFrom(ctx, command), ...args.slice(0, -1));
    };
  };
  const program2 = new Command(CLI_NAME);
  program2.description("KontextMind operator CLI (agent, session, workflow, gate, mesh, improve)").exitOverride().configureOutput({
    writeOut: (text) => ctx.io.stdout(text),
    writeErr: (text) => ctx.io.stderr(text)
  }).helpCommand("help", "Show help");
  addGlobalOptions(program2);
  const agent = addGlobalOptions(program2.command("agent").description("Run and supervise agents"));
  agent.helpCommand("help", "Show agent help");
  addGlobalOptions(agent.command("worker").description("Start a long-lived Pi worker")).option("--name <name>", "Agent name").option("--project <project>", "Mesh project").option("--model <id>", "Primary model").option("--fallback-models <ids>", "Comma-separated fallback models").option("--tools <names>", "Comma-separated Pi tool allowlist").option("--no-continue", "Disable every session resume").option("--fresh-start", "Skip only the initial session resume").action(async function workerAction(options) {
    result.code = await cmdWorker(runtimeFrom(ctx, this), options);
  });
  const session = addGlobalOptions(program2.command("session").description("Inspect and drain Pi worker sessions"));
  session.helpCommand("help", "Show session help");
  addGlobalOptions(session.command("status").description("Show session claims and recovery envelopes")).action(bind(cmdSessionStatus));
  addGlobalOptions(session.command("start").description("Start a mix of agents and gates, or a workflow session")).option("--id <id>", "Session id").option("--workflow <id>", "Workflow definition id").option("--mix <names>", "Comma-separated agent and gate names").action(async function sessionStartAction(options) {
    result.code = await cmdSessionStart(runtimeFrom(ctx, this), options);
  });
  addGlobalOptions(session.command("stop").description("Request managed hub and worker session shutdown")).option("--wait-ms <ms>", "How long to wait for PID files to clear").action(async function sessionStopAction(options) {
    result.code = await cmdStop(runtimeFrom(ctx, this), options.waitMs);
  });
  const workflow = addGlobalOptions(program2.command("workflow").description("Start and inspect workflow runs"));
  workflow.helpCommand("help", "Show workflow help");
  addGlobalOptions(workflow.command("list").description("List local workflow runs")).action(async function listAction() {
    result.code = await cmdWorkflowInspect(runtimeFrom(ctx, this), "list");
  });
  addGlobalOptions(workflow.command("get").description("Show one local workflow run")).argument("<runId>", "Workflow run ID").action(async function getAction(runId) {
    result.code = await cmdWorkflowInspect(runtimeFrom(ctx, this), "get", runId);
  });
  addGlobalOptions(workflow.command("start").description("POST a signed workflow-start webhook")).argument("[definitionId]", "Workflow definition ID").option("--payload <json>", "JSON object or @file", "{}").option("--delivery-id <id>", "Stable provider delivery ID").option("--event <name>", "Optional provider event name").action(async function startAction(definitionId, options) {
    result.code = await cmdWorkflowStart(runtimeFrom(ctx, this), definitionId, options);
  });
  addGlobalOptions(workflow.command("export").description("Export a proposed retrospective")).argument("<runId>", "Workflow run ID").option("--input <file>", "Offline snapshot JSON").option("--out-dir <dir>", "Directory under workspace assets").action(async function exportAction(runId, options) {
    result.code = await cmdRetrospectiveExport(runtimeFrom(ctx, this), runId, options);
  });
  const gate = addGlobalOptions(program2.command("gate").description("Validate definitions and operate evidence gates"));
  gate.helpCommand("help", "Show gate help");
  addGlobalOptions(gate.command("validate").description("Parse workflow definitions without printing secrets")).option("--file <path>", "Workflow definition file").action(async function validateAction(options) {
    result.code = await cmdValidate(runtimeFrom(ctx, this), options.file);
  });
  addGlobalOptions(gate.command("artifacts-exist").description("Verify a non-empty file under workspace assets")).requiredOption("--path <file>", "Artifact file under workspace assets").action(async function artifactsExistAction(options) {
    result.code = await cmdArtifactsExist(runtimeFrom(ctx, this), options.path);
  });
  addGlobalOptions(gate.command("degrade").description("Approve a configured lower peer quorum")).argument("<runId>", "Workflow run ID").argument("<stageId>", "Active stage ID").option("--requirement <key>", "Canonical requirement key").option("--reason <text>", "Non-secret operator reason").action(async function degradeAction(runId, stageId, options) {
    result.code = await cmdWorkflowDegrade(runtimeFrom(ctx, this), runId, stageId, options);
  });
  addGlobalOptions(gate.command("signal").description("Post a signed workflow callback")).argument("<runId>", "Workflow run ID").argument("<signalKey>", "Wait signal key").argument("<status>", "passed, warning, or failed").argument("<summary>", "Callback summary").argument("[evidence...]", "required-key=evidence pairs").option("--delivery-id <id>", "Stable callback delivery ID").action(async function signalAction(runId, signalKey, status, summary, evidence, options) {
    result.code = await cmdSignal(runtimeFrom(ctx, this), runId, signalKey, status, summary, evidence ?? [], options.deliveryId);
  });
  const github = addGlobalOptions(gate.command("github").description("GitHub adapters"));
  github.helpCommand("help", "Show GitHub help");
  addGlobalOptions(github.command("watch").description("Poll required checks and post the signed signal")).option("--run-id <id>", "Workflow run ID").option("--stage-id <id>", "Waiting stage ID").option("--signal-key <key>", "Wait signal key").option("--repo <owner/name>", "GitHub repository").option("--pr <number>", "Pull request number").option("--required <names>", "Comma-separated required check names").option("--timeout-ms <ms>", "Watch timeout").option("--interval-ms <ms>", "Poll interval").option("--delivery-id <id>", "Stable callback delivery ID").action(async function watchAction(options) {
    result.code = await cmdGithubWatch(runtimeFrom(ctx, this), options);
  });
  addGlobalOptions(program2.command("improve").description("Propose CLI or project improvements from telemetry JSONL")).option("--target <cli|project>", "Limit proposals to cli or project").action(async function improveAction(options) {
    result.code = await cmdImprove(runtimeFrom(ctx, this), options.target);
  });
  const mesh = addGlobalOptions(program2.command("mesh").description("Local and multi-machine mesh hub"));
  mesh.helpCommand("help", "Show mesh help");
  addGlobalOptions(mesh.command("init").description("Create .kxm directories")).action(bind(cmdInit));
  addGlobalOptions(mesh.command("status").description("Check hub /health and /ready")).action(bind(cmdStatus));
  addGlobalOptions(mesh.command("tui").description("Live mesh observer TUI (SSE presence, no bodies)")).action(bind(cmdMeshTui));
  addGlobalOptions(mesh.command("hub").description("Start the mesh hub")).action(bind(cmdHub));
  addGlobalOptions(mesh.command("stop").description("Request managed hub and worker shutdown")).option("--wait-ms <ms>", "How long to wait for PID files to clear").action(async function stopAction(options) {
    result.code = await cmdStop(runtimeFrom(ctx, this), options.waitMs);
  });
  addGlobalOptions(mesh.command("smoke").description("Opt-in two-worker real-Pi release harness")).option("--real-pi", "Run even when PI_MESH_SMOKE is unset").action(async function smokeAction(options) {
    result.code = await cmdSmoke(runtimeFrom(ctx, this), Boolean(options.realPi));
  });
  return program2;
}
function mapCommanderError(error) {
  if (error.exitCode === 0) return 0;
  if (USAGE_ERROR_CODES.has(error.code)) return 2;
  return error.exitCode || 1;
}
async function runCli(argv, env = process.env, io = { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) }, cwd = process.cwd()) {
  const originalStdout = io.stdout;
  const originalStderr = io.stderr;
  io = { ...io, stdout: (text) => originalStdout(redactConfiguredValues(text, env)), stderr: (text) => originalStderr(redactConfiguredValues(text, env)) };
  const result = { code: 0 };
  const program2 = createProgram({ env, io, cwd }, result);
  try {
    await program2.parseAsync(argv, { from: "user" });
    return result.code;
  } catch (error) {
    if (error instanceof CommanderError) return mapCommanderError(error);
    throw error;
  }
}
if (process.argv[1] && resolve3(process.argv[1]) === fileURLToPath2(import.meta.url)) {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}
export {
  runCli
};
