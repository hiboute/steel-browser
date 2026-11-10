import { requestSchema, type CommandRequest } from "../commands/commands.js";
import type { RecoveryStep } from "./types.js";
import { WorkbenchError } from "./workbench.service.js";

export function recoveryCommands(step: RecoveryStep, site: string): CommandRequest {
  const args =
    step.args && typeof step.args === "object" ? (step.args as Record<string, unknown>) : {};
  const name = step.tool.replace(/^(?:browser|web)_/, "");
  const target =
    args.target ?? (typeof args.selector === "string" ? { css: args.selector } : undefined);
  let commands: unknown;
  if (name === "commands") commands = args.commands;
  else if (name === "navigate") commands = [{ command: "navigate", url: args.url }];
  else if (name === "click") commands = [{ command: "click", target }];
  else if (name === "select" || name === "select_option")
    commands = [{ command: "select", target, values: args.values ?? args.value }];
  else if (name === "wait" || name === "wait_for")
    commands = [
      {
        command: "wait",
        ...(target ? { target } : {}),
        ...(args.ms !== undefined ? { ms: args.ms } : {}),
        ...(args.text !== undefined ? { text: args.text } : {}),
        ...(args.url !== undefined ? { url: args.url } : {}),
        ...(args.state !== undefined ? { state: args.state } : {}),
      },
    ];
  else if (name === "scroll")
    commands = [
      {
        command: "scroll",
        ...(target ? { target } : {}),
        ...(args.direction ? { direction: args.direction } : {}),
        ...(args.amount !== undefined ? { amount: args.amount } : {}),
      },
    ];
  else
    throw new WorkbenchError(
      409,
      "unsupported_recovery_step",
      `Review ${step.tool} as a supported browser command before applying it`,
    );
  const parsed = requestSchema.safeParse({ commands });
  if (!parsed.success)
    throw new WorkbenchError(
      409,
      "invalid_recovery_step",
      `Recovery step ${step.seq} needs a valid target or action value`,
    );
  for (const command of parsed.data.commands) {
    if (!["navigate", "click", "wait", "scroll", "select"].includes(command.command))
      throw new WorkbenchError(
        409,
        "unsupported_recovery_step",
        "Recovery only supports reviewed navigation, click, wait, scroll and selection actions",
      );
    if (command.command === "navigate") {
      let matches = false;
      try {
        matches = new URL(command.url).origin === site;
      } catch {}
      if (!matches)
        throw new WorkbenchError(
          409,
          "origin_mismatch",
          "A recovery navigation must remain on the lesson's site",
        );
    }
  }
  return parsed.data;
}
