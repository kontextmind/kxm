import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe, beforeEach, afterEach } from "node:test";
import {
  truncateSshOutput,
  parseSshConfig,
  resolveSshHostG,
  ensureSocketDir,
  buildSshArgs,
  checkControlSocket,
  closeControlSocket,
  pruneSocketDir,
  executeSshRun,
  MAX_SSH_OUTPUT_BYTES,
  MAX_SSH_OUTPUT_LINES,
} from "../../plugins/kxm/src/ssh-remote.ts";
import { runCli } from "../../plugins/kxm/src/cli.ts";

describe("ssh-remote execution & multiplexing", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kxm-ssh-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("truncateSshOutput", () => {
    test("preserves output within bounds", () => {
      const short = "hello world\nline 2";
      const res = truncateSshOutput(short);
      assert.equal(res.truncated, false);
      assert.equal(res.text, short);
    });

    test("truncates output exceeding byte limit", () => {
      const large = "A".repeat(MAX_SSH_OUTPUT_BYTES + 500);
      const res = truncateSshOutput(large);
      assert.equal(res.truncated, true);
      assert.ok(res.text.includes("[kxm: ssh output truncated"));
    });

    test("truncates output exceeding line limit", () => {
      const manyLines = Array.from({ length: MAX_SSH_OUTPUT_LINES + 50 }, (_, i) => `line ${i}`).join("\n");
      const res = truncateSshOutput(manyLines);
      assert.equal(res.truncated, true);
      assert.ok(res.text.includes("[kxm: ssh output truncated"));
    });
  });

  describe("parseSshConfig", () => {
    test("returns empty array for non-existent config", () => {
      const hosts = parseSshConfig(join(tempDir, "nonexistent"));
      assert.deepEqual(hosts, []);
    });

    test("parses host aliases, proxyjump, and identities correctly", () => {
      const configPath = join(tempDir, "config");
      const configContent = `
# Global default
Host *
  ServerAliveInterval 60

Host build-box gpu-node
  HostName 10.0.1.50
  User builder
  Port 2222
  ProxyJump bastion.internal
  IdentityFile ~/.ssh/id_ed25519

Host db-replica
  HostName db.internal
  User postgres
`;
      writeFileSync(configPath, configContent, "utf-8");
      const hosts = parseSshConfig(configPath);
      assert.equal(hosts.length, 3);
      assert.equal(hosts[0]?.alias, "build-box");
      assert.equal(hosts[0]?.hostName, "10.0.1.50");
      assert.equal(hosts[0]?.user, "builder");
      assert.equal(hosts[0]?.port, 2222);
      assert.equal(hosts[0]?.proxyJump, "bastion.internal");
      assert.ok(hosts[0]?.identityFiles?.includes("~/.ssh/id_ed25519"));

      assert.equal(hosts[1]?.alias, "gpu-node");
      assert.equal(hosts[2]?.alias, "db-replica");
      assert.equal(hosts[2]?.user, "postgres");
    });
  });

  describe("resolveSshHostG", () => {
    test("parses ssh -G output into SshHostInfo", () => {
      const mockGOutput = `hostname worker1.cloud.local\nuser devops\nport 2200\nproxyjump bastion\nidentityfile /home/user/.ssh/id_rsa\n`;
      const mockExec = () => ({
        status: 0,
        stdout: mockGOutput,
        stderr: "",
      });

      const info = resolveSshHostG("worker1", mockExec as any);
      assert.equal(info.alias, "worker1");
      assert.equal(info.hostName, "worker1.cloud.local");
      assert.equal(info.user, "devops");
      assert.equal(info.port, 2200);
      assert.equal(info.proxyJump, "bastion");
      assert.ok(info.identityFiles?.includes("/home/user/.ssh/id_rsa"));
    });

    test("falls back gracefully on non-zero exit status", () => {
      const mockExec = () => ({
        status: 1,
        stdout: "",
        stderr: "error",
      });

      const info = resolveSshHostG("unknown-host", mockExec as any);
      assert.equal(info.alias, "unknown-host");
      assert.equal(info.hostName, "unknown-host");
    });
  });

  describe("buildSshArgs & security invariants", () => {
    test("builds valid OpenSSH ControlMaster arguments", () => {
      const args = buildSshArgs({
        host: "prod-server",
        socketDir: tempDir,
        controlPersist: "15m",
      });

      assert.ok(args.includes("-o"));
      assert.ok(args.includes("ControlMaster=auto"));
      assert.ok(args.includes("ControlPersist=15m"));
      assert.ok(args.includes("BatchMode=yes"));
      assert.ok(args.includes("StrictHostKeyChecking=yes"));
      assert.equal(args[args.length - 1], "prod-server");
    });

    test("rejects insecure host key policies with safety brake", () => {
      assert.throws(() => {
        buildSshArgs({
          host: "prod-server",
          socketDir: tempDir,
          extraArgs: ["-o", "StrictHostKeyChecking=no"],
        });
      }, /Insecure SSH host key policy rejected/);
    });
  });

  describe("checkControlSocket, closeControlSocket & pruneSocketDir", () => {
    test("returns true when socket check succeeds", () => {
      const mockExec = (_cmd: string, args: string[]) => {
        if (args.includes("-O") && args.includes("check")) {
          return { status: 0, stdout: "Master running", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "" };
      };

      const active = checkControlSocket("host1", tempDir, mockExec as any);
      assert.equal(active, true);
    });

    test("returns true when socket stop succeeds", () => {
      const mockExec = (_cmd: string, args: string[]) => {
        if (args.includes("-O") && args.includes("stop")) {
          return { status: 0, stdout: "Exit request sent", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "" };
      };

      const stopped = closeControlSocket("host1", tempDir, mockExec as any);
      assert.equal(stopped, true);
    });

    test("prunes sockets safely in directory", () => {
      const count = pruneSocketDir(tempDir);
      assert.equal(typeof count, "number");
    });
  });

  describe("executeSshRun execution flows", () => {
    test("handles action: 'info' with and without host", () => {
      const mockGOutput = `hostname worker1.cloud.local\nuser devops\nport 2200\n`;
      const mockExec = () => ({ status: 0, stdout: mockGOutput, stderr: "" });

      const allReceipt = executeSshRun({ action: "info" });
      assert.equal(allReceipt.ok, true);
      assert.equal(allReceipt.action, "info");
      assert.ok(Array.isArray(allReceipt.hosts));

      const hostReceipt = executeSshRun({ action: "info", host: "worker1", execFn: mockExec as any });
      assert.equal(hostReceipt.ok, true);
      assert.equal(hostReceipt.resolvedHost, "worker1.cloud.local");
      assert.equal(hostReceipt.user, "devops");
    });

    test("rejects missing host for action: 'command' or 'file'", () => {
      const cmdReceipt = executeSshRun({ action: "command", command: "ls -la" });
      assert.equal(cmdReceipt.ok, false);
      assert.ok(cmdReceipt.error?.includes('Parameter "host" is required'));

      const fileReceipt = executeSshRun({ action: "file", file_path: "/tmp/foo" });
      assert.equal(fileReceipt.ok, false);
      assert.ok(fileReceipt.error?.includes('Parameter "host" is required'));
    });

    test("rejects missing command for action: 'command'", () => {
      const receipt = executeSshRun({ action: "command", host: "remote-node" });
      assert.equal(receipt.ok, false);
      assert.ok(receipt.error?.includes('Parameter "command" is required'));
    });

    test("rejects missing file_path for action: 'file'", () => {
      const receipt = executeSshRun({ action: "file", host: "remote-node" });
      assert.equal(receipt.ok, false);
      assert.ok(receipt.error?.includes('Parameter "file_path" is required'));
    });

    test("blocks destructive command on remote host via safety seatbelt", () => {
      const receipt = executeSshRun({
        action: "command",
        host: "remote-node",
        command: "rm -rf /var/log/*",
      });
      assert.equal(receipt.ok, false);
      assert.ok(receipt.error?.includes("Command blocked by KXM safety seatbelt"));
    });

    test("executes remote command successfully with mock execFn", () => {
      let capturedArgs: string[] = [];
      const mockExec = (_cmd: string, args: string[]) => {
        capturedArgs = args;
        return { status: 0, stdout: "total 4\n-rw-r--r-- 1 test test 100 file.txt", stderr: "" };
      };

      const receipt = executeSshRun({
        action: "command",
        host: "remote-node",
        command: "ls -l",
        socket_dir: tempDir,
        execFn: mockExec as any,
      });

      assert.equal(receipt.ok, true);
      assert.equal(receipt.exitCode, 0);
      assert.ok(receipt.stdout?.includes("file.txt"));
      assert.ok(capturedArgs.includes("ls -l"));
    });

    test("handles thrown exceptions during command execution", () => {
      const mockExec = () => {
        throw new Error("SSH process crash");
      };

      const receipt = executeSshRun({
        action: "command",
        host: "remote-node",
        command: "ls -la",
        socket_dir: tempDir,
        execFn: mockExec as any,
      });

      assert.equal(receipt.ok, false);
      assert.equal(receipt.error, "SSH process crash");
    });

    test("uses sshpass and SSHPASS env var when password is provided", () => {
      let capturedBinary = "";
      let capturedEnv: Record<string, string | undefined> | undefined = undefined;
      const mockExec = (cmd: string, _args: string[], opts: any) => {
        capturedBinary = cmd;
        capturedEnv = opts.env;
        return { status: 0, stdout: "authenticated output", stderr: "" };
      };

      const receipt = executeSshRun({
        action: "command",
        host: "remote-node",
        command: "whoami",
        password: "secret-ssh-password",
        socket_dir: tempDir,
        execFn: mockExec as any,
      });

      assert.equal(receipt.ok, true);
      assert.equal(capturedBinary, "sshpass");
      assert.equal(capturedEnv?.["SSHPASS"], "secret-ssh-password");
    });

    test("handles sudo commands without explicit sudo_password (falls back to password)", () => {
      let capturedInput: string | undefined = undefined;
      const mockExec = (_cmd: string, _args: string[], opts: any) => {
        capturedInput = opts.input;
        return { status: 0, stdout: "ok", stderr: "" };
      };

      const receipt = executeSshRun({
        action: "command",
        host: "remote-node",
        command: "systemctl status",
        sudo: true,
        password: "fallback-password",
        socket_dir: tempDir,
        execFn: mockExec as any,
      });

      assert.equal(receipt.ok, true);
      assert.equal(capturedInput, "fallback-password\n");
    });

    test("handles action: 'file' write, append, and read operations", () => {
      let capturedArgs: string[] = [];
      let capturedInput: string | undefined = undefined;
      const mockExec = (_cmd: string, args: string[], opts: any) => {
        capturedArgs = args;
        capturedInput = opts.input;
        return { status: 0, stdout: "file content here", stderr: "" };
      };

      const writeReceipt = executeSshRun({
        action: "file",
        host: "remote-node",
        file_path: "/tmp/config.json",
        file_content: '{"active": true}',
        file_op: "write",
        socket_dir: tempDir,
        execFn: mockExec as any,
      });
      assert.equal(writeReceipt.ok, true);
      assert.equal(writeReceipt.fileProcessed, "/tmp/config.json");
      assert.equal(capturedInput, '{"active": true}');

      const appendReceipt = executeSshRun({
        action: "file",
        host: "remote-node",
        file_path: "/tmp/log.txt",
        file_content: "new entry\n",
        file_op: "append",
        sudo: true,
        socket_dir: tempDir,
        execFn: mockExec as any,
      });
      assert.equal(appendReceipt.ok, true);
      assert.ok(capturedArgs.join(" ").includes("sudo tee -a"));

      const readReceipt = executeSshRun({
        action: "file",
        host: "remote-node",
        file_path: "/tmp/config.json",
        file_op: "read",
        sudo: true,
        socket_dir: tempDir,
        execFn: mockExec as any,
      });
      assert.equal(readReceipt.ok, true);
      assert.ok(capturedArgs.join(" ").includes("sudo cat"));
    });

    test("handles unknown action gracefully", () => {
      const receipt = executeSshRun({
        action: "unknown" as any,
        host: "remote-node",
      });
      assert.equal(receipt.ok, false);
      assert.ok(receipt.error?.includes("Unknown action"));
    });
  });

  describe("CLI kxm ssh commands", () => {
    test("runs 'kxm ssh info' in text and json mode", async () => {
      let stdout = "";
      let stderr = "";
      const jsonCode = await runCli(
        ["ssh", "info", "--json"],
        process.env,
        { stdout: (t) => { stdout += t; }, stderr: (t) => { stderr += t; } },
        tempDir,
      );
      assert.equal(jsonCode, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, true);

      let textStdout = "";
      const textCode = await runCli(
        ["ssh", "info"],
        process.env,
        { stdout: (t) => { textStdout += t; }, stderr: () => {} },
        tempDir,
      );
      assert.equal(textCode, 0);
    });

    test("runs 'kxm ssh close <host>' in text and json mode", async () => {
      let stdout = "";
      let stderr = "";
      const jsonCode = await runCli(
        ["ssh", "close", "build-node", "--json"],
        process.env,
        { stdout: (t) => { stdout += t; }, stderr: (t) => { stderr += t; } },
        tempDir,
      );
      assert.equal(jsonCode, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.command, "ssh close");
      assert.equal(parsed.host, "build-node");

      let textStdout = "";
      const textCode = await runCli(
        ["ssh", "close", "build-node"],
        process.env,
        { stdout: (t) => { textStdout += t; }, stderr: () => {} },
        tempDir,
      );
      assert.equal(textCode, 0);
      assert.ok(textStdout.includes("build-node"));
    });
  });
});
