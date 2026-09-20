"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { resolveCodexExecutable, runCodex } = require("../codex-exec-led.cjs");

function installation(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mchose-codex-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = {
    LOCALAPPDATA: path.join(root, "local"),
    USERPROFILE: path.join(root, "user"),
    PATH: path.join(root, "path"),
  };
  const add = (candidate, seconds = 1) => {
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
    fs.writeFileSync(candidate, "fixture, never executed");
    fs.utimesSync(candidate, seconds, seconds);
    return candidate;
  };
  return { root, env, add };
}

test("an explicitly configured Codex executable is preserved", (t) => {
  const fixture = installation(t);
  const executable = fixture.add(path.join(fixture.root, "custom.exe"));
  assert.equal(resolveCodexExecutable({ codex: { codexExecutable: executable } }, { env: {} }), executable);
  assert.throws(() => resolveCodexExecutable({ codex: { codexExecutable: executable + ".missing" } }), /does not exist/);
});

test("automatic discovery prefers the newest Desktop executable over VS Code and PATH", (t) => {
  const { env, add } = installation(t);
  add(path.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin", "old", "codex.exe"), 10);
  const newest = add(path.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin", "new", "codex.exe"), 20);
  add(path.join(env.USERPROFILE, ".vscode", "extensions", "openai.chatgpt-newer", "bin", "windows-x86_64", "codex.exe"), 30);
  add(path.join(env.PATH, "codex.exe"), 40);
  assert.equal(resolveCodexExecutable({ codex: { codexExecutable: "auto" } }, { env }), newest);
});

test("automatic discovery falls back to VS Code and then PATH", (t) => {
  const { env, add } = installation(t);
  add(path.join(env.USERPROFILE, ".vscode", "extensions", "unrelated-extension", "bin", "windows-x86_64", "codex.exe"), 30);
  const extension = add(path.join(env.USERPROFILE, ".vscode", "extensions", "openai.chatgpt-fixture", "bin", "windows-x86_64", "codex.exe"), 20);
  const onPath = add(path.join(env.PATH, "codex.exe"));
  assert.equal(resolveCodexExecutable({ codex: { codexExecutable: "auto" } }, { env }), extension);
  fs.unlinkSync(extension);
  assert.equal(resolveCodexExecutable({ codex: { codexExecutable: "auto" } }, { env }), onPath);
  fs.unlinkSync(onPath);
  assert.throws(() => resolveCodexExecutable({ codex: { codexExecutable: "auto" } }, { env }), /No Codex CLI executable/);
});

test("unset discovery roots and empty PATH do not search the working directory", () => {
  const searched = [];
  const fileSystem = { existsSync(candidate) { searched.push(candidate); return true; } };
  assert.throws(() => resolveCodexExecutable({ codex: { codexExecutable: "auto" } }, { env: {}, fileSystem }), /No Codex CLI executable/);
  assert.deepEqual(searched, []);
});

async function simulate(t, options = {}) {
  const events = [];
  const output = [];
  const diagnostics = [];
  const signalSource = new EventEmitter();
  const jsonl = options.jsonl ?? '{"type":"turn.completed"}\n';
  const childStderr = options.childStderr ?? "";
  const exitCode = options.exitCode ?? 0;
  let starts = 0;
  let daemonAttempts = 0;
  const source = `
    const output = Buffer.from(${JSON.stringify(Buffer.from(jsonl).toString("base64"))}, "base64");
    process.stdout.write(output);
    process.stderr.write(${JSON.stringify(childStderr)});
    process.exitCode = ${exitCode};
  `;
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mchose-codex-child-"));
  const fixtureScript = path.join(fixtureDirectory, "child.cjs");
  fs.writeFileSync(fixtureScript, source);
  t.after(() => fs.rmSync(fixtureDirectory, { recursive: true, force: true }));
  const code = await runCodex(["--", "--json", "--ephemeral", "fixture prompt"], {
    config: { runtimeDirectory: "unused-fixture-runtime", configPath: "unused-fixture-config" },
    codexExecutable: "fixture-codex.exe",
    controllerEnabled() {
      if (options.stateError) throw options.stateError;
      return options.enabled !== false;
    },
    async startDaemon() {
      daemonAttempts += 1;
      if (options.daemonError) throw options.daemonError;
    },
    async sendStatus(message) {
      events.push(message.event);
      if (options.failNotification === message.event.kind) throw new Error("fixture IPC disconnected");
    },
    spawn(executable, args, spawnOptions) {
      starts += 1;
      assert.equal(executable, "fixture-codex.exe");
      assert.deepEqual(args, ["exec", "--json", "--ephemeral", "fixture prompt"]);
      assert.match(spawnOptions.env.MCHOSE_CODEX_LED_WRAPPED_TASK, /^exec:/);
      const child = childProcess.spawn(process.execPath, [fixtureScript], spawnOptions);
      t.after(() => { if (child.exitCode === null) child.kill(); });
      return child;
    },
    stdout: { write(chunk) { output.push(Buffer.from(chunk)); } },
    stderr: { write(chunk) { diagnostics.push(Buffer.from(chunk)); } },
    signalSource,
  });
  assert.equal(starts, 1, "the actual task must run exactly once");
  assert.deepEqual(Buffer.concat(output), Buffer.from(jsonl), "stdout must remain byte-for-byte unchanged");
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
  return { code, events, stderr: Buffer.concat(diagnostics).toString(), daemonAttempts };
}

test("success waits for drained JSONL, including a final event without a newline", async (t) => {
  const jsonl = JSON.stringify({ type: "item.completed", text: "汉字".repeat(30000) }) + '\r\n{"type":"turn.completed"}';
  const result = await simulate(t, { jsonl, childStderr: "child diagnostic\n" });
  assert.equal(result.code, 0);
  assert.deepEqual(result.events.map((event) => event.kind), ["turn_started", "turn_completed"]);
  assert.equal(result.stderr, "child diagnostic\n");
});

test("a failed task preserves its nonzero child exit code", async (t) => {
  const result = await simulate(t, { jsonl: '{"type":"turn.failed"}\n', exitCode: 17 });
  assert.equal(result.code, 17);
  assert.equal(result.events.at(-1).kind, "turn_failed");
});

test("a completed event with a nonzero exit code is not reported as success", async (t) => {
  const result = await simulate(t, { exitCode: 9 });
  assert.equal(result.code, 9);
  assert.equal(result.events.at(-1).kind, "turn_failed");
});

test("a missing terminal event fails the lighting indication but preserves a zero exit code", async (t) => {
  const result = await simulate(t, { jsonl: '{"type":"thread.started"}\n' });
  assert.equal(result.code, 0);
  assert.equal(result.events.at(-1).kind, "turn_failed");
});

test("an unavailable daemon cannot prevent a successful CLI task", async (t) => {
  const result = await simulate(t, { daemonError: new Error("fixture daemon offline") });
  assert.equal(result.code, 0);
  assert.deepEqual(result.events, []);
  assert.match(result.stderr, /Lighting is unavailable.*fixture daemon offline/);
});

test("a stopped controller does not restart or prevent the CLI task", async (t) => {
  const result = await simulate(t, { enabled: false });
  assert.equal(result.code, 0);
  assert.equal(result.daemonAttempts, 0);
  assert.deepEqual(result.events, []);
  assert.match(result.stderr, /Controller is stopped/);
});

test("unreadable controller state does not prevent the CLI task", async (t) => {
  const result = await simulate(t, { stateError: new Error("fixture state unreadable") });
  assert.equal(result.code, 0);
  assert.equal(result.daemonAttempts, 0);
  assert.deepEqual(result.events, []);
  assert.match(result.stderr, /fixture state unreadable/);
});

test("a failed start notification does not prevent execution or completion reporting", async (t) => {
  const result = await simulate(t, { failNotification: "turn_started" });
  assert.equal(result.code, 0);
  assert.deepEqual(result.events.map((event) => event.kind), ["turn_started", "turn_completed"]);
  assert.match(result.stderr, /Could not report turn_started/);
});

test("a failed completion notification does not turn a successful CLI task into a failure", async (t) => {
  const result = await simulate(t, { failNotification: "turn_completed" });
  assert.equal(result.code, 0);
  assert.deepEqual(result.events.map((event) => event.kind), ["turn_started", "turn_completed"]);
  assert.match(result.stderr, /Could not report turn_completed/);
});

test("a failed failure notification does not replace the CLI exit code", async (t) => {
  const result = await simulate(t, { jsonl: '{"type":"turn.failed"}\n', exitCode: 17, failNotification: "turn_failed" });
  assert.equal(result.code, 17);
  assert.deepEqual(result.events.map((event) => event.kind), ["turn_started", "turn_failed"]);
  assert.match(result.stderr, /Could not report turn_failed/);
});

test("a child spawn failure preserves the original error even if status reporting fails", async () => {
  const events = [];
  const signalSource = new EventEmitter();
  const spawnError = Object.assign(new Error("fixture spawn failure"), { code: "ENOENT" });
  await assert.rejects(runCodex(["fixture prompt"], {
    config: {},
    codexExecutable: "fixture-codex.exe",
    controllerEnabled: () => true,
    startDaemon: async () => {},
    sendStatus: async ({ event }) => {
      events.push(event);
      if (event.kind === "turn_failed") throw new Error("fixture IPC failure");
    },
    spawn() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit("error", spawnError));
      return child;
    },
    stdout: { write() {} },
    stderr: { write() {} },
    signalSource,
  }), (error) => error === spawnError);
  assert.deepEqual(events.map((event) => event.kind), ["turn_started", "turn_failed"]);
  assert.equal(events.at(-1).wrapperError.code, "ENOENT");
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});
