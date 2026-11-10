import type { SessionService } from "../session.service.js";
import type { FileService } from "../file.service.js";
import { CommandEngine } from "./engine.js";
import { AccessError } from "../control/access.js";
import { quickActionsDone } from "../../modules/commands/commands.guard.js";

/** Engines and their references/idempotency journals belong to sessions, never pool slots. */
export class SessionCommands {
  private engines = new Map<string, CommandEngine>();
  constructor(
    private sessions: SessionService,
    private files: FileService,
  ) {}
  get(id: string): CommandEngine {
    const session = this.sessions.getSession(id);
    if (!session || session.status !== "live" || session.isSelenium)
      throw new AccessError("session_not_live", "Commands require a live CDP browser", 409);
    let engine = this.engines.get(id);
    if (engine) return engine;
    engine = new CommandEngine({
      browser: () => session.cdpService.getBrowserInstance(),
      waitForPageSetup: (p) => session.cdpService.waitForPageSetup(p),
      endSession: async () => {
        await this.sessions.endSession(id);
      },
      filesRoot: () => this.files.forSession(id).getBaseFilesPath(),
      released: () => this.sessions.getSession(id) !== session || session.status !== "live",
      quickActionsDone: () => quickActionsDone(engine!),
    });
    engine.prepare(id);
    const browser = session.cdpService.getBrowserInstance();
    if (browser) engine.browserLaunched(browser);
    engine.browserReady();
    this.engines.set(id, engine);
    return engine;
  }
  busy(id: string) {
    return this.engines.get(id)?.busy() ?? false;
  }
  reset(id: string) {
    const engine = this.engines.get(id);
    engine?.sessionEnded();
    this.engines.delete(id);
  }
  close() {
    for (const id of this.engines.keys()) this.reset(id);
  }
}
