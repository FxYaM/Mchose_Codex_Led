"use strict";

// Synthetic protocol bytes: no captured keyboard state or machine identifiers.
// Literal headers/offsets deliberately avoid importing the implementation under test.
function createK99State() {
  const performance = Buffer.from(Array.from({ length: 136 }, (_, index) => (index * 37 + 11) & 255));
  performance.set([6, 0x84, 0, 0, 1, 0, 0x80, 0]);
  performance[17] = 0;
  performance[18] = 1;
  performance[68] = 3;
  performance[69] = 0x10;
  performance.set([0x5a, 0xa5], 134);
  const lightColor = Buffer.from(Array.from({ length: 520 }, (_, index) => (index * 29 + 7) & 255));
  lightColor.set([6, 0x8a, 0, 0, 1, 0, 0, 2]);
  lightColor.set([12, 34, 56], 50);
  lightColor.set([0x5a, 0xa5], 514);
  return {
    identity: {
      vendorId: 0x258a, productId: 0x010c, product: "K99 V2", manufacturer: "BY Tech",
      release: 0x0200, serialNumber: "", usagePage: 0xff00, usage: 1,
      interface: 1, collection: "Col06", endpointPath: "synthetic-k99-col06",
    },
    performance,
    lightColor,
  };
}

module.exports = { createK99State };
