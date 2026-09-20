"use strict";

const path = require("node:path");
const {
  brightnessPercentToLevel,
  colorToRgb,
  diffOffsets,
  sleep,
} = require("./common.cjs");

const REPORT_LENGTH = 520;
const PERFORMANCE_RESPONSE_LENGTH = 136;
const COLOR_RESPONSE_LENGTH = 520;
const READ_SETTLE_MS = 5;
const STABLE_READ_ATTEMPTS = 4;
const synchronousWaitCell = new Int32Array(new SharedArrayBuffer(4));

const OFFSETS = Object.freeze({
  reportId: 0,
  command: 1,
  lightType: 17,
  lightMode: 18,
  staticBrightness: 66,
  staticPacked: 67,
  breathingBrightness: 68,
  breathingPacked: 69,
  loopBrightness: 70,
  loopPacked: 71,
  staticRgb: 29,
  breathingRgb: 50,
  loopRgb: 71,
});

const COMMANDS = Object.freeze({
  readPerformance: 0x84,
  readColor: 0x8a,
  writePerformance: 0x04,
  // The official bundle stores wiredCommand as the JS string "10". Its
  // serializer passes it through Uint8Array, so this is decimal 10 (0x0A).
  writeColor: 0x0a,
});

class DeviceOfflineError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "DeviceOfflineError";
    this.code = "DEVICE_OFFLINE";
  }
}

class IdentityMismatchError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "IdentityMismatchError";
    this.code = "IDENTITY_MISMATCH";
    this.details = details;
  }
}

class HidCloseError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "HidCloseError";
    this.code = "HID_CLOSE_FAILED";
  }
}

class ProtocolVerificationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ProtocolVerificationError";
    this.code = "READBACK_MISMATCH";
    this.details = details;
  }
}

function findNestedInstance(error, Constructor) {
  if (!error) return null;
  if (error instanceof Constructor) return error;
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const found = findNestedInstance(nested, Constructor);
      if (found) return found;
    }
  }
  return findNestedInstance(error.cause, Constructor);
}

function collectionFromPath(devicePath) {
  const match = /&col(\d{2})#/i.exec(devicePath || "");
  return match ? `Col${match[1]}` : null;
}

function identityFromDevice(device) {
  return {
    vendorId: device.vendorId,
    productId: device.productId,
    product: device.product || "",
    manufacturer: device.manufacturer || "",
    release: device.release,
    serialNumber: device.serialNumber || "",
    usagePage: device.usagePage,
    usage: device.usage,
    interface: device.interface,
    collection: collectionFromPath(device.path),
    endpointPath: device.path,
  };
}

function stableIdentityFields(identity) {
  return {
    vendorId: identity.vendorId,
    productId: identity.productId,
    product: identity.product,
    manufacturer: identity.manufacturer,
    release: identity.release,
    serialNumber: identity.serialNumber || "",
    usagePage: identity.usagePage,
    usage: identity.usage,
    interface: identity.interface,
    collection: identity.collection,
  };
}

function compareIdentity(expected, actual, acceptDevice = false) {
  const differences = [];
  for (const [field, value] of Object.entries(stableIdentityFields(expected))) {
    if (actual[field] !== value) differences.push({ field, expected: value, actual: actual[field] });
  }

  // Windows may assign a different HID endpoint path to the same physical
  // keyboard after reboot, reconnect, or USB re-enumeration. The selected
  // device has already been constrained by the configured VID/PID, product,
  // manufacturer, release, usage page, usage, interface and collection, and
  // selectDevice() refuses ambiguous multi-device matches. Treat endpointPath
  // as transport metadata rather than stable identity when all stable fields
  // match. --accept-device still exists for explicit recovery when stable
  // identity fields differ.
  if (differences.length === 0) return [];

  return differences;
}

function assertPrefix(buffer, expected, label) {
  if (buffer.length < expected.length) throw new Error(`${label} is shorter than its protocol header`);
  for (let index = 0; index < expected.length; index += 1) {
    if (buffer[index] !== expected[index]) {
      throw new Error(`${label} has an unexpected byte at offset ${index}: ${buffer[index]} != ${expected[index]}`);
    }
  }
}

function waitSync(milliseconds) {
  Atomics.wait(synchronousWaitCell, 0, 0, milliseconds);
}

function validatePerformanceResponse(buffer, reportId = 0x06) {
  if (!Buffer.isBuffer(buffer)) throw new Error("Performance response must be a Buffer");
  if (buffer.length !== PERFORMANCE_RESPONSE_LENGTH) {
    throw new Error(`Performance response length must be ${PERFORMANCE_RESPONSE_LENGTH}; got ${buffer.length}`);
  }
  assertPrefix(buffer, [reportId, COMMANDS.readPerformance, 0, 0, 1, 0, 0x80, 0], "Performance response");
  if (buffer[134] !== 0x5a || buffer[135] !== 0xa5) {
    throw new Error("Performance response is missing the 0x5A 0xA5 marker at offsets 134-135");
  }
  return true;
}

function validateColorResponse(buffer, reportId = 0x06) {
  if (!Buffer.isBuffer(buffer)) throw new Error("Light-color response must be a Buffer");
  if (buffer.length !== COLOR_RESPONSE_LENGTH) {
    throw new Error(`Light-color response length must be ${COLOR_RESPONSE_LENGTH}; got ${buffer.length}`);
  }
  assertPrefix(buffer, [reportId, COMMANDS.readColor, 0, 0, 1, 0, 0, 2], "Light-color response");
  if (buffer[514] !== 0x5a || buffer[515] !== 0xa5) {
    throw new Error("Light-color response is missing the 0x5A 0xA5 marker at offsets 514-515");
  }
  return true;
}

function presetDetails(preset) {
  if (preset.mode === "preserve") return { mode: "preserve" };
  const staticMode = preset.mode === "static";
  return {
    mode: staticMode ? 1 : 2,
    brightnessOffset: staticMode ? OFFSETS.staticBrightness : OFFSETS.breathingBrightness,
    packedOffset: staticMode ? OFFSETS.staticPacked : OFFSETS.breathingPacked,
    colorOffset: staticMode ? OFFSETS.staticRgb : OFFSETS.breathingRgb,
    brightnessLevel: brightnessPercentToLevel(preset.brightnessPercent),
    speedRaw: staticMode ? null : preset.breathingSpeed - 1,
    rgb: colorToRgb(preset.color),
  };
}

function stateMatchesPreset(state, preset) {
  if (preset.mode === "preserve") return true;
  const details = presetDetails(preset);
  const packed = state.performance[details.packedOffset];
  const performanceMatches =
    state.performance[OFFSETS.lightType] === 0 &&
    state.performance[OFFSETS.lightMode] === details.mode &&
    state.performance[details.brightnessOffset] === details.brightnessLevel &&
    (packed & 0x0f) === 0 &&
    (details.speedRaw === null || (packed >> 4) === details.speedRaw);
  const colorMatches = state.lightColor
    .subarray(details.colorOffset, details.colorOffset + 3)
    .equals(Buffer.from(details.rgb));
  return performanceMatches && colorMatches;
}

function buildPerformanceWritePacket(readResponse, preset) {
  validatePerformanceResponse(readResponse);
  const details = presetDetails(preset);
  if (details.mode === "preserve") throw new Error("A preserve preset does not have a write packet");
  const report = Buffer.alloc(REPORT_LENGTH);
  readResponse.copy(report);
  report[OFFSETS.command] = COMMANDS.writePerformance;
  report[OFFSETS.lightType] = 0;
  report[OFFSETS.lightMode] = details.mode;
  report[details.brightnessOffset] = details.brightnessLevel;
  if (details.speedRaw === null) {
    report[details.packedOffset] &= 0xf0;
  } else {
    report[details.packedOffset] = (details.speedRaw << 4) | 0x00;
  }
  return report;
}

function buildColorWritePacket(readResponse, preset) {
  validateColorResponse(readResponse);
  const details = presetDetails(preset);
  if (details.mode === "preserve") throw new Error("A preserve preset does not have a write packet");
  const report = Buffer.from(readResponse);
  report[OFFSETS.command] = COMMANDS.writeColor;
  report.set(details.rgb, details.colorOffset);
  return report;
}

function buildExactRestorePackets(state) {
  validatePerformanceResponse(state.performance);
  validateColorResponse(state.lightColor);
  const performance = Buffer.alloc(REPORT_LENGTH);
  state.performance.copy(performance);
  performance[OFFSETS.command] = COMMANDS.writePerformance;
  const lightColor = Buffer.from(state.lightColor);
  lightColor[OFFSETS.command] = COMMANDS.writeColor;
  return { performance, lightColor };
}

function summarizeState(state) {
  return {
    identity: state.identity,
    lightType: state.performance[OFFSETS.lightType],
    lightMode: state.performance[OFFSETS.lightMode],
    static: {
      color: [...state.lightColor.subarray(OFFSETS.staticRgb, OFFSETS.staticRgb + 3)],
      brightnessLevel: state.performance[OFFSETS.staticBrightness],
      packed: state.performance[OFFSETS.staticPacked],
    },
    breathing: {
      color: [...state.lightColor.subarray(OFFSETS.breathingRgb, OFFSETS.breathingRgb + 3)],
      brightnessLevel: state.performance[OFFSETS.breathingBrightness],
      speedRaw: state.performance[OFFSETS.breathingPacked] >> 4,
      speedSetting: (state.performance[OFFSETS.breathingPacked] >> 4) + 1,
      multiColor: state.performance[OFFSETS.breathingPacked] & 0x0f,
      packed: state.performance[OFFSETS.breathingPacked],
    },
  };
}

class K99Protocol {
  constructor(config, options = {}) {
    this.config = config;
    this.packageDirectory = options.packageDirectory || path.resolve(__dirname, "..");
    this.HID = options.hidModule || null;
  }

  loadHid() {
    if (!this.HID) {
      this.HID = require(path.join(this.packageDirectory, "vendor", "node_modules", "node-hid"));
    }
    return this.HID;
  }

  enumerate() {
    const HID = this.loadHid();
    return HID.devices(this.config.vendorId, this.config.productId).map(identityFromDevice);
  }

  selectDevice() {
    const expected = this.config;
    const matches = this.enumerate().filter(
      (device) =>
        device.vendorId === expected.vendorId &&
        device.productId === expected.productId &&
        device.usagePage === expected.usagePage &&
        device.usage === expected.usage &&
        device.interface === expected.interface &&
        device.collection?.toLowerCase() === expected.collection.toLowerCase() &&
        device.product.toLowerCase() === expected.product.toLowerCase() &&
        (!expected.manufacturer || device.manufacturer.toLowerCase() === expected.manufacturer.toLowerCase()) &&
        (!expected.release || device.release === expected.release),
    );
    if (matches.length === 0) {
      throw new DeviceOfflineError("MCHOSE K99 V2 Col06 control endpoint is not connected");
    }
    if (matches.length !== 1) {
      throw new IdentityMismatchError(`Expected one matching K99 V2 control endpoint; found ${matches.length}`, { matches });
    }
    return matches[0];
  }

  openSelected() {
    const identity = this.selectDevice();
    try {
      return { identity, device: new (this.loadHid().HID)(identity.endpointPath) };
    } catch (error) {
      throw new DeviceOfflineError(`Unable to open K99 V2 control endpoint: ${error.message}`, error);
    }
  }

  withOpenedSync(callback) {
    const opened = this.openSelected();
    let result;
    let primaryError;
    let closeError;
    try {
      result = callback(opened.device, opened.identity);
    } catch (error) {
      primaryError = error;
    }
    try {
      opened.device.close();
    } catch (error) {
      closeError = new HidCloseError(`Closing the K99 V2 HID endpoint failed: ${error.message}`, error);
    }
    if (primaryError && closeError) {
      throw new AggregateError([primaryError, closeError], "K99 V2 operation and HID close both failed");
    }
    if (primaryError) throw primaryError;
    if (closeError) throw closeError;
    return result;
  }

  async withOpened(callback, options = {}) {
    const openRetryDelaysMs = options.openRetryDelaysMs ?? [100, 250, 500];
    let opened;
    for (let attempt = 0; ; attempt += 1) {
      try {
        opened = this.openSelected();
        break;
      } catch (error) {
        if (!(error instanceof DeviceOfflineError) || attempt >= openRetryDelaysMs.length) throw error;
        await sleep(openRetryDelaysMs[attempt]);
      }
    }
    let result;
    let primaryError;
    let closeError;
    try {
      result = await callback(opened.device, opened.identity);
    } catch (error) {
      primaryError = error;
    }
    try {
      opened.device.close();
    } catch (error) {
      closeError = new HidCloseError(`Closing the K99 V2 HID endpoint failed: ${error.message}`, error);
    }
    if (primaryError && closeError) {
      throw new AggregateError([primaryError, closeError], "K99 V2 operation and HID close both failed");
    }
    if (primaryError) throw primaryError;
    if (closeError) throw closeError;
    return result;
  }

  writeFeature(device, report) {
    if (!Buffer.isBuffer(report) || report.length !== REPORT_LENGTH || report[0] !== this.config.reportId) {
      throw new Error("Refusing to write a malformed K99 V2 Feature Report");
    }
    const written = device.sendFeatureReport([...report]);
    if (written !== REPORT_LENGTH) throw new Error(`Short K99 V2 Feature Report write: ${written}`);
  }

  readCommand(device, command, tail, validate, label) {
    let previous = null;
    const observations = [];
    for (let attempt = 1; attempt <= STABLE_READ_ATTEMPTS; attempt += 1) {
      const request = Buffer.alloc(REPORT_LENGTH);
      request.set([this.config.reportId, command, 0, 0, 1, 0, ...tail]);
      this.writeFeature(device, request);
      waitSync(READ_SETTLE_MS);
      const response = Buffer.from(device.getFeatureReport(this.config.reportId, REPORT_LENGTH));
      try {
        validate(response, this.config.reportId);
        observations.push({ attempt, length: response.length, valid: true });
        if (previous && previous.equals(response)) return response;
        previous = response;
      } catch (error) {
        observations.push({ attempt, length: response.length, valid: false, error: error.message });
        previous = null;
      }
      waitSync(READ_SETTLE_MS);
    }
    const error = new Error(`${label} did not produce two consecutive identical validated responses`);
    error.code = "UNSTABLE_HID_READ";
    error.details = { observations };
    throw error;
  }

  readStateOnDevice(device, identity) {
    const performance = this.readCommand(
      device,
      COMMANDS.readPerformance,
      [0x80, 0x00],
      validatePerformanceResponse,
      "Performance state",
    );
    const lightColor = this.readCommand(
      device,
      COMMANDS.readColor,
      [0x00, 0x02],
      validateColorResponse,
      "Light-color state",
    );
    return { identity, performance, lightColor };
  }

  readState() {
    try {
      return this.withOpenedSync((device, identity) => this.readStateOnDevice(device, identity));
    } catch (error) {
      if (
        error instanceof DeviceOfflineError ||
        error instanceof IdentityMismatchError ||
        error instanceof HidCloseError ||
        error instanceof AggregateError
      ) throw error;
      throw new DeviceOfflineError(`K99 V2 read failed: ${error.message}`, error);
    }
  }

  async applyPreset(preset, timings = {}) {
    if (preset.mode === "preserve") return { skipped: true, reason: "preserve" };
    const commandDelayMs = timings.commandDelayMs ?? 60;
    const readbackDelayMs = timings.readbackDelayMs ?? 180;
    try {
      return await this.withOpened(async (device, identity) => {
        const before = this.readStateOnDevice(device, identity);
        if (stateMatchesPreset(before, preset)) {
          return { skipped: true, reason: "already-applied", before, after: before };
        }
        const details = presetDetails(preset);
        const performanceNeeded = !(
          before.performance[OFFSETS.lightType] === 0 &&
          before.performance[OFFSETS.lightMode] === details.mode &&
          before.performance[details.brightnessOffset] === details.brightnessLevel &&
          (before.performance[details.packedOffset] & 0x0f) === 0 &&
          (details.speedRaw === null || before.performance[details.packedOffset] >> 4 === details.speedRaw)
        );
        const colorNeeded = !before.lightColor
          .subarray(details.colorOffset, details.colorOffset + 3)
          .equals(Buffer.from(details.rgb));
        if (performanceNeeded) this.writeFeature(device, buildPerformanceWritePacket(before.performance, preset));
        if (performanceNeeded && colorNeeded) await sleep(commandDelayMs);
        if (colorNeeded) this.writeFeature(device, buildColorWritePacket(before.lightColor, preset));
        await sleep(readbackDelayMs);
        const after = this.readStateOnDevice(device, identity);
        if (!stateMatchesPreset(after, preset)) {
          throw new ProtocolVerificationError(
            `K99 V2 readback did not match requested ${preset.mode} preset`,
            { expected: presetDetails(preset), actual: summarizeState(after) },
          );
        }
        return {
          skipped: false,
          performanceWritten: performanceNeeded,
          colorWritten: colorNeeded,
          before,
          after,
        };
      }, { openRetryDelaysMs: timings.openRetryDelaysMs });
    } catch (error) {
      if (
        error instanceof IdentityMismatchError ||
        error instanceof HidCloseError ||
        error instanceof ProtocolVerificationError ||
        error instanceof AggregateError
      ) throw error;
      throw new DeviceOfflineError(`K99 V2 preset write/readback failed: ${error.message}`, error);
    }
  }

  async restoreExact(snapshotState, options = {}) {
    const commandDelayMs = options.commandDelayMs ?? 60;
    const readbackDelayMs = options.readbackDelayMs ?? 180;
    try {
      return await this.withOpened(async (device, identity) => {
        const identityDifferences = compareIdentity(snapshotState.identity, identity, options.acceptDevice);
        if (identityDifferences.length > 0) {
          throw new IdentityMismatchError("Connected device does not match the snapshot identity", identityDifferences);
        }
        const packets = buildExactRestorePackets(snapshotState);
        this.writeFeature(device, packets.performance);
        await sleep(commandDelayMs);
        this.writeFeature(device, packets.lightColor);
        await sleep(readbackDelayMs);
        const after = this.readStateOnDevice(device, identity);
        const performanceDifferences = diffOffsets(after.performance, snapshotState.performance, 2);
        const colorDifferences = diffOffsets(after.lightColor, snapshotState.lightColor, 2);
        return {
          ok: performanceDifferences.length === 0 && colorDifferences.length === 0,
          after,
          performanceDifferences,
          colorDifferences,
        };
      }, { openRetryDelaysMs: options.openRetryDelaysMs });
    } catch (error) {
      const identityMismatch = findNestedInstance(error, IdentityMismatchError);
      if (identityMismatch) throw identityMismatch;
      if (error instanceof DeviceOfflineError) throw error;
      throw new DeviceOfflineError(`K99 V2 restore write/readback failed: ${error.message}`, error);
    }
  }
}

module.exports = {
  COLOR_RESPONSE_LENGTH,
  COMMANDS,
  DeviceOfflineError,
  HidCloseError,
  IdentityMismatchError,
  K99Protocol,
  OFFSETS,
  PERFORMANCE_RESPONSE_LENGTH,
  ProtocolVerificationError,
  REPORT_LENGTH,
  buildColorWritePacket,
  buildExactRestorePackets,
  buildPerformanceWritePacket,
  compareIdentity,
  identityFromDevice,
  presetDetails,
  stableIdentityFields,
  stateMatchesPreset,
  summarizeState,
  validateColorResponse,
  validatePerformanceResponse,
};
