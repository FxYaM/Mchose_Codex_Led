"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { brightnessPercentToLevel, loadConfig } = require("../lib/common.cjs");
const {
  COMMANDS,
  DeviceOfflineError,
  IdentityMismatchError,
  K99Protocol,
  OFFSETS,
  buildColorWritePacket,
  buildExactRestorePackets,
  buildPerformanceWritePacket,
  stateMatchesPreset,
  validateColorResponse,
  validatePerformanceResponse,
} = require("../lib/protocol.cjs");

const packageDirectory = path.resolve(__dirname, "..");
const baselineDirectory = path.join(
  packageDirectory,
  "snapshots",
  "legacy-baseline-k99v2-258a-010c-20260913T142853+0800",
);
const baseline = {
  performance: fs.readFileSync(path.join(baselineDirectory, "performance.bin")),
  lightColor: fs.readFileSync(path.join(baselineDirectory, "light-color.bin")),
};
const config = loadConfig(packageDirectory);

test("legacy responses have the exact K99 V2 headers and markers", () => {
  assert.equal(validatePerformanceResponse(baseline.performance), true);
  assert.equal(validateColorResponse(baseline.lightColor), true);
  assert.equal(baseline.performance[134], 0x5a);
  assert.equal(baseline.performance[135], 0xa5);
  assert.equal(baseline.lightColor[514], 0x5a);
  assert.equal(baseline.lightColor[515], 0xa5);
});

test("running packet changes only documented performance fields", () => {
  const packet = buildPerformanceWritePacket(baseline.performance, config.states.running);
  assert.equal(packet.length, 520);
  assert.equal(packet[1], COMMANDS.writePerformance);
  assert.equal(packet[OFFSETS.lightType], 0);
  assert.equal(packet[OFFSETS.lightMode], 2);
  assert.equal(packet[OFFSETS.breathingBrightness], 3);
  assert.equal(packet[OFFSETS.breathingPacked], 0x30);
  const changed = [];
  for (let index = 0; index < baseline.performance.length; index += 1) {
    if (packet[index] !== baseline.performance[index]) changed.push(index);
  }
  assert.deepEqual(changed, [1, 18, 69]);
});

test("light-color write uses decimal ten (0x0A), preserves marker, and sets breathing RGB", () => {
  const packet = buildColorWritePacket(baseline.lightColor, config.states.running);
  assert.equal(packet.length, 520);
  assert.equal(packet[1], 0x0a);
  assert.deepEqual([...packet.subarray(50, 53)], [0, 96, 255]);
  assert.deepEqual([...packet.subarray(498)], [...baseline.lightColor.subarray(498)]);
  const changed = [];
  for (let index = 0; index < packet.length; index += 1) {
    if (packet[index] !== baseline.lightColor[index]) changed.push(index);
  }
  assert.deepEqual(changed, [1, 50, 51, 52]);
});

test("a simulated readback matches the requested running preset", () => {
  const performancePacket = buildPerformanceWritePacket(baseline.performance, config.states.running);
  const colorPacket = buildColorWritePacket(baseline.lightColor, config.states.running);
  const simulated = {
    performance: Buffer.from(performancePacket.subarray(0, 136)),
    lightColor: Buffer.from(colorPacket),
  };
  simulated.performance[1] = COMMANDS.readPerformance;
  simulated.lightColor[1] = COMMANDS.readColor;
  assert.equal(stateMatchesPreset(simulated, config.states.running), true);
});

test("exact restore packets preserve every payload byte", () => {
  const packets = buildExactRestorePackets(baseline);
  assert.equal(packets.performance[1], COMMANDS.writePerformance);
  assert.equal(packets.lightColor[1], COMMANDS.writeColor);
  assert.ok(packets.performance.subarray(2, 136).equals(baseline.performance.subarray(2)));
  assert.ok(packets.lightColor.subarray(2).equals(baseline.lightColor.subarray(2)));
});

test("brightness percentage maps to the official four hardware levels", () => {
  assert.equal(brightnessPercentToLevel(1), 1);
  assert.equal(brightnessPercentToLevel(25), 1);
  assert.equal(brightnessPercentToLevel(26), 2);
  assert.equal(brightnessPercentToLevel(50), 2);
  assert.equal(brightnessPercentToLevel(75), 3);
  assert.equal(brightnessPercentToLevel(100), 4);
  assert.throws(() => brightnessPercentToLevel(0));
  assert.throws(() => brightnessPercentToLevel(101));
});

test("tampered marker is rejected before any write packet can be built", () => {
  const corrupted = Buffer.from(baseline.lightColor);
  corrupted[514] = 0;
  assert.throws(() => validateColorResponse(corrupted), /marker/);
  assert.throws(() => buildColorWritePacket(corrupted, config.states.running), /marker/);
});

test("state reads reject a 137-byte HID artifact and require two identical packets", () => {
  const artifact = Buffer.concat([Buffer.from(baseline.performance), Buffer.from([0])]);
  artifact[0] = 0;
  const responses = [
    artifact,
    Buffer.from(baseline.performance),
    Buffer.from(baseline.performance),
    Buffer.from(baseline.lightColor),
    Buffer.from(baseline.lightColor),
  ];
  let writes = 0;
  const fakeDevice = {
    sendFeatureReport(report) {
      writes += 1;
      assert.equal(report.length, 520);
      return 520;
    },
    getFeatureReport() {
      return [...responses.shift()];
    },
  };
  const protocol = new K99Protocol(config.device, { packageDirectory });
  const state = protocol.readStateOnDevice(fakeDevice, { product: "K99 V2" });
  assert.ok(state.performance.equals(baseline.performance));
  assert.ok(state.lightColor.equals(baseline.lightColor));
  assert.equal(writes, 5);
  assert.equal(responses.length, 0);
});

test("restore classifies mid-operation HID failures as offline but preserves identity mismatches", async () => {
  const offlineProtocol = new K99Protocol(config.device, { packageDirectory });
  offlineProtocol.withOpened = async () => { throw new Error("device vanished during write"); };
  await assert.rejects(
    offlineProtocol.restoreExact({ ...baseline, identity: legacyIdentity() }),
    (error) => error instanceof DeviceOfflineError && error.code === "DEVICE_OFFLINE",
  );

  const identityProtocol = new K99Protocol(config.device, { packageDirectory });
  identityProtocol.withOpened = async () => {
    throw new IdentityMismatchError("wrong keyboard", [{ field: "endpointPath" }]);
  };
  await assert.rejects(
    identityProtocol.restoreExact({ ...baseline, identity: legacyIdentity() }),
    (error) => error instanceof IdentityMismatchError && error.code === "IDENTITY_MISMATCH",
  );
});

function legacyIdentity() {
  return JSON.parse(fs.readFileSync(path.join(baselineDirectory, "manifest.json"), "utf8")).device;
}
