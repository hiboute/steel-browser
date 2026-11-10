import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { spawn, ChildProcess } from "child_process";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { SeleniumService } from "./selenium.service.js";

function createMockLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

function createMockChildProcess(): ChildProcess & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const mockChild = new EventEmitter() as ChildProcess & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  mockChild.stdout = new EventEmitter() as never;
  mockChild.stderr = new EventEmitter() as never;
  Object.assign(mockChild, { exitCode: null, signalCode: null });
  mockChild.kill = vi.fn((signal: NodeJS.Signals) => {
    Object.assign(mockChild, { signalCode: signal });
    mockChild.emit("close", null, signal);
    return true;
  }) as never;
  return mockChild;
}

describe("SeleniumService", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe("launch error handling", () => {
    it("rejects when the child process emits an error event", async () => {
      const mockChild = createMockChildProcess();
      vi.mocked(spawn).mockReturnValue(mockChild);

      const logger = createMockLogger();
      const service = new SeleniumService(logger as never);

      const launchPromise = service.launch({} as never);

      const spawnError = Object.assign(new Error("spawn java ENOENT"), {
        code: "ENOENT",
      });
      mockChild.emit("error", spawnError);

      await expect(launchPromise).rejects.toMatchObject({
        code: "ENOENT",
        message: expect.stringContaining("spawn java ENOENT"),
      });
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: spawnError }),
        expect.stringContaining("Selenium process error"),
      );
      await expect(service.close()).resolves.toBeUndefined();
    });

    it("rejects when the child process exits prematurely before becoming ready", async () => {
      const mockChild = createMockChildProcess();
      vi.mocked(spawn).mockReturnValue(mockChild);

      const logger = createMockLogger();
      const service = new SeleniumService(logger as never);

      const launchPromise = service.launch({} as never);

      mockChild.emit("close", 1);

      await expect(launchPromise).rejects.toThrow(
        "Selenium process exited prematurely with code 1",
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ code: 1 }),
        expect.stringContaining("Selenium process exited"),
      );
      await expect(service.close()).resolves.toBeUndefined();
    });

    it("resolves when the selenium standalone server starts successfully", async () => {
      const mockChild = createMockChildProcess();
      vi.mocked(spawn).mockReturnValue(mockChild);

      const logger = createMockLogger();
      const service = new SeleniumService(logger as never);

      const launchPromise = service.launch({} as never);

      mockChild.stdout.emit("data", Buffer.from("Started Selenium Standalone 4.25.0"));

      await expect(launchPromise).resolves.toBeUndefined();
      expect(service.getSeleniumServerUrl()).toBe("http://localhost:4444");

      // Verify transient startup listeners are cleaned up, leaving only permanent handlers
      expect(mockChild.listenerCount("error")).toBe(1);
      expect(mockChild.listenerCount("close")).toBe(1);
      expect(mockChild.stdout.listenerCount("data")).toBe(1);
      expect(mockChild.stderr.listenerCount("data")).toBe(1);

      // Verify close kills the running process
      await service.close();
      expect(mockChild.kill).toHaveBeenCalledWith("SIGINT");

      mockChild.emit("close", null, "SIGINT");
      expect(logger.info).toHaveBeenCalledWith(
        { code: null, signal: "SIGINT" },
        "Selenium process exited",
      );
    });

    it("times out and cleans up if startup message is not received", async () => {
      vi.useFakeTimers();

      const mockChild = createMockChildProcess();
      vi.mocked(spawn).mockReturnValue(mockChild);

      const logger = createMockLogger();
      const service = new SeleniumService(logger as never);

      const launchPromise = service.launch({} as never);

      // Fast-forward past 15 seconds
      vi.advanceTimersByTime(15000);

      await expect(launchPromise).rejects.toThrow(
        "Selenium server failed to start within the timeout period",
      );
      expect(mockChild.kill).toHaveBeenCalledWith("SIGINT");
    });

    it("resolves when startup message arrives in split chunks", async () => {
      const mockChild = createMockChildProcess();
      vi.mocked(spawn).mockReturnValue(mockChild);

      const logger = createMockLogger();
      const service = new SeleniumService(logger as never);

      const launchPromise = service.launch({} as never);

      mockChild.stdout.emit("data", Buffer.from("Started Selenium "));
      mockChild.stdout.emit("data", Buffer.from("Standalone"));

      await expect(launchPromise).resolves.toBeUndefined();
      expect(service.getSeleniumServerUrl()).toBe("http://localhost:4444");
      await service.close();
    });

    it("resolves when more than 4KB follows the startup message in one chunk", async () => {
      const mockChild = createMockChildProcess();
      vi.mocked(spawn).mockReturnValue(mockChild);

      const logger = createMockLogger();
      const service = new SeleniumService(logger as never);

      const launchPromise = service.launch({} as never);

      mockChild.stdout.emit(
        "data",
        Buffer.from(`Started Selenium Standalone 4.25.0\n${"x".repeat(5000)}\n`),
      );

      await expect(launchPromise).resolves.toBeUndefined();
      await service.close();
    });

    it("recovers and resolves after a failed launch", async () => {
      const mockChild1 = createMockChildProcess();
      const mockChild2 = createMockChildProcess();
      vi.mocked(spawn).mockReturnValueOnce(mockChild1).mockReturnValueOnce(mockChild2);

      const logger = createMockLogger();
      const service = new SeleniumService(logger as never);

      const firstLaunch = service.launch({} as never);
      mockChild1.emit("error", new Error("spawn java ENOENT"));
      await expect(firstLaunch).rejects.toThrow("spawn java ENOENT");

      const secondLaunch = service.launch({} as never);
      mockChild2.stdout.emit("data", Buffer.from("Started Selenium Standalone"));
      await expect(secondLaunch).resolves.toBeUndefined();
      expect(service.getSeleniumServerUrl()).toBe("http://localhost:4444");
      await service.close();
      expect(mockChild2.kill).toHaveBeenCalledWith("SIGINT");
    });

    it("closes existing process before launching a new one", async () => {
      const mockChild1 = createMockChildProcess();
      const mockChild2 = createMockChildProcess();

      let spawnCount = 0;
      vi.mocked(spawn).mockImplementation((() => {
        spawnCount++;
        return spawnCount === 1 ? mockChild1 : mockChild2;
      }) as never);

      const logger = createMockLogger();
      const service = new SeleniumService(logger as never);

      const firstLaunch = service.launch({} as never);
      mockChild1.stdout.emit("data", Buffer.from("Started Selenium Standalone"));
      await firstLaunch;

      const secondLaunch = service.launch({} as never);
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));

      expect(mockChild1.kill).toHaveBeenCalledWith("SIGINT");

      mockChild2.stdout.emit("data", Buffer.from("Started Selenium Standalone"));
      await secondLaunch;
    });

    it("does not kill or nullify a newer process if an older superseded process closes or fails", async () => {
      const mockChild1 = createMockChildProcess();
      const mockChild2 = createMockChildProcess();

      let spawnCount = 0;
      vi.mocked(spawn).mockImplementation((() => {
        spawnCount++;
        return spawnCount === 1 ? mockChild1 : mockChild2;
      }) as never);

      const logger = createMockLogger();
      const service = new SeleniumService(logger as never);

      const firstLaunch = service.launch({} as never);
      const firstRejected = expect(firstLaunch).rejects.toThrow("exited prematurely");
      mockChild1.kill.mockReturnValue(true).mockImplementation(() => true);
      // A replacement launch waits for the previous process to exit.
      const secondLaunch = service.launch({} as never);
      await Promise.resolve();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(mockChild1.kill).toHaveBeenCalledWith("SIGINT");
      mockChild1.emit("close", 1);
      await firstRejected;
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));

      // Late notifications from the old process cannot affect the new one.
      mockChild1.emit("error", new Error("first launch failed"));
      expect(mockChild2.kill).not.toHaveBeenCalled();

      // mockChild1 emits close
      mockChild1.emit("close", 1);

      // mockChild2 finishes startup
      mockChild2.stdout.emit("data", Buffer.from("Started Selenium Standalone"));
      await secondLaunch;

      // Closing service should target mockChild2 (it was not nullified by mockChild1's close)
      await service.close();
      expect(mockChild2.kill).toHaveBeenCalledWith("SIGINT");
    });

    it("keeps close pending until process exit and shares concurrent closes", async () => {
      const child = createMockChildProcess();
      child.kill.mockImplementation(() => true);
      vi.mocked(spawn).mockReturnValue(child);
      const service = new SeleniumService(createMockLogger() as never);
      const launch = service.launch({} as never);
      child.stdout.emit("data", "Started Selenium Standalone");
      await launch;
      const closed = service.close();
      expect(service.close()).toBe(closed);
      const done = vi.fn();
      void closed.then(done);
      await Promise.resolve();
      expect(done).not.toHaveBeenCalled();
      child.emit("close", 0);
      await closed;
      expect(child.kill).toHaveBeenCalledTimes(1);
    });

    it("rejects a stuck shutdown and retains the process for cleanup retry", async () => {
      vi.useFakeTimers();
      const child = createMockChildProcess();
      child.kill.mockImplementation(() => true);
      vi.mocked(spawn).mockReturnValue(child);
      const service = new SeleniumService(createMockLogger() as never);
      const launch = service.launch({} as never);
      child.stdout.emit("data", "Started Selenium Standalone");
      await launch;
      const rejected = expect(service.close()).rejects.toThrow("did not stop");
      await vi.advanceTimersByTimeAsync(5000);
      await rejected;
      const retry = service.close();
      expect(child.kill).toHaveBeenCalledTimes(2);
      child.emit("close", 0);
      await retry;
    });
  });
});
