import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the OS sandbox SDK so the tests never touch sandbox-exec / bubblewrap.
const mock = {
  isSupportedPlatform: vi.fn(() => true),
  checkDependencies: vi.fn(() => ({ errors: [] as string[], warnings: [] as string[] })),
  initialize: vi.fn(async () => {}),
  wrapWithSandbox: vi.fn(async (cmd: string) => `SANDBOXED(${cmd})`),
  cleanupAfterCommand: vi.fn(),
  annotateStderrWithSandboxFailures: vi.fn((_cmd: string, out: string) => `${out}\n<violations/>`),
  getSandboxViolationStore: vi.fn(() => ({
    getViolationsForCommand: (_cmd: string) => [
      { line: "deny file-write /etc/passwd", timestamp: new Date(0) },
    ],
  })),
  reset: vi.fn(async () => {}),
};

vi.mock("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: mock }));

const { createSandbox } = await import("./sandbox.js");

beforeEach(() => {
  for (const fn of Object.values(mock)) vi.mocked(fn).mockClear();
  mock.isSupportedPlatform.mockReturnValue(true);
  mock.checkDependencies.mockReturnValue({ errors: [], warnings: [] });
});

describe("createSandbox", () => {
  it("is inactive and never initializes when disabled", async () => {
    const ctl = await createSandbox({ enabled: false, writeRoots: ["/ws"] });
    expect(ctl.active).toBe(false);
    expect(ctl.bridge).toBeUndefined();
    expect(ctl.reason).toBe("disabled");
    expect(mock.initialize).not.toHaveBeenCalled();
    await expect(ctl.dispose()).resolves.toBeUndefined();
  });

  it("is inactive on an unsupported platform", async () => {
    mock.isSupportedPlatform.mockReturnValue(false);
    const ctl = await createSandbox({ enabled: true, writeRoots: ["/ws"] });
    expect(ctl.active).toBe(false);
    expect(ctl.reason).toBe("unsupported platform");
    expect(mock.initialize).not.toHaveBeenCalled();
  });

  it("is inactive when host dependencies are missing", async () => {
    mock.checkDependencies.mockReturnValue({ errors: ["ripgrep not found"], warnings: [] });
    const ctl = await createSandbox({ enabled: true, writeRoots: ["/ws"] });
    expect(ctl.active).toBe(false);
    expect(ctl.reason).toContain("ripgrep not found");
    expect(mock.initialize).not.toHaveBeenCalled();
  });

  it("initializes with workspace write roots and an unrestricted network when network is omitted", async () => {
    const ctl = await createSandbox({
      enabled: true,
      writeRoots: ["/ws", "/extra-root"],
      extraAllowWrite: ["~/.npm"],
      denyWrite: [".env"],
      denyRead: ["~/.ssh"],
      allowGitConfig: true,
      monitorViolations: true,
    });
    expect(ctl.active).toBe(true);
    expect(ctl.bridge).toBeDefined();

    expect(mock.initialize).toHaveBeenCalledTimes(1);
    const [config, ask, monitor] = mock.initialize.mock.calls[0]! as unknown as [
      {
        filesystem: {
          allowWrite: string[];
          denyWrite: string[];
          denyRead: string[];
          allowGitConfig: boolean;
        };
        network: { allowedDomains?: string[] };
      },
      unknown,
      boolean,
    ];
    expect(config.filesystem.allowWrite).toEqual(["/ws", "/extra-root", "~/.npm"]);
    expect(config.filesystem.denyWrite).toEqual([".env"]);
    expect(config.filesystem.denyRead).toEqual(["~/.ssh"]);
    expect(config.filesystem.allowGitConfig).toBe(true);
    // No network → SDK applies no network restriction.
    expect(config.network.allowedDomains).toBeUndefined();
    expect(ask).toBeUndefined();
    expect(monitor).toBe(true);
  });

  it("passes network config through to the SDK when set", async () => {
    const ctl = await createSandbox({
      enabled: true,
      writeRoots: ["/ws"],
      network: {
        allowedDomains: ["api.example.com"],
        deniedDomains: ["bad.example.com"],
        allowLocalBinding: true,
        httpProxyPort: 8080,
      },
    });
    expect(ctl.active).toBe(true);

    const [config] = mock.initialize.mock.calls[0]! as unknown as [
      { network: { allowedDomains: string[]; deniedDomains: string[]; allowLocalBinding?: boolean; httpProxyPort?: number } },
      unknown,
      boolean,
    ];
    expect(config.network.allowedDomains).toEqual(["api.example.com"]);
    expect(config.network.deniedDomains).toEqual(["bad.example.com"]);
    expect(config.network.allowLocalBinding).toBe(true);
    expect(config.network.httpProxyPort).toBe(8080);
  });

  it("bridge.wrapCommand wraps via the SDK and passes the abort signal", async () => {
    const ctl = await createSandbox({ enabled: true, writeRoots: ["/ws"] });
    const signal = new AbortController().signal;
    const wrapped = await ctl.bridge!.wrapCommand("echo hi", signal);
    expect(wrapped).toBe("SANDBOXED(echo hi)");
    expect(mock.wrapWithSandbox).toHaveBeenCalledWith("echo hi", "/bin/bash", undefined, signal);
  });

  it("bridge.wrapCommand fails open when the SDK throws", async () => {
    mock.wrapWithSandbox.mockRejectedValueOnce(new Error("boom"));
    const ctl = await createSandbox({ enabled: true, writeRoots: ["/ws"] });
    await expect(ctl.bridge!.wrapCommand("echo hi")).resolves.toBe("echo hi");
  });

  it("bridge.afterCommand and annotateOutput delegate to the SDK", async () => {
    const ctl = await createSandbox({ enabled: true, writeRoots: ["/ws"] });
    ctl.bridge!.afterCommand();
    expect(mock.cleanupAfterCommand).toHaveBeenCalledTimes(1);
    expect(ctl.bridge!.annotateOutput("echo hi", "out")).toBe("out\n<violations/>");
  });

  it("bridge.violationsForCommand returns recorded violation lines", async () => {
    const ctl = await createSandbox({ enabled: true, writeRoots: ["/ws"] });
    expect(ctl.bridge!.violationsForCommand("echo hi")).toEqual(["deny file-write /etc/passwd"]);
  });

  it("bridge.violationsForCommand returns [] when the store throws (monitoring off)", async () => {
    mock.getSandboxViolationStore.mockImplementationOnce(() => {
      throw new Error("no monitor");
    });
    const ctl = await createSandbox({ enabled: true, writeRoots: ["/ws"] });
    expect(ctl.bridge!.violationsForCommand("echo hi")).toEqual([]);
  });

  it("dispose resets the SDK", async () => {
    const ctl = await createSandbox({ enabled: true, writeRoots: ["/ws"] });
    await ctl.dispose();
    expect(mock.reset).toHaveBeenCalledTimes(1);
  });

  it("degrades to inactive when initialize throws", async () => {
    mock.initialize.mockRejectedValueOnce(new Error("init failed"));
    const ctl = await createSandbox({ enabled: true, writeRoots: ["/ws"] });
    expect(ctl.active).toBe(false);
    expect(ctl.bridge).toBeUndefined();
    expect(ctl.reason).toBe("init failed");
    // Best-effort cleanup of the partial init.
    expect(mock.reset).toHaveBeenCalled();
  });
});
