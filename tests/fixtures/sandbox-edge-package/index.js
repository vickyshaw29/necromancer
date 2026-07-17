module.exports = function edgeValue(kind) {
  if (kind === "undefined") return undefined;
  if (kind === "nan") return Number.NaN;
  if (kind === "infinity") return Infinity;
  if (kind === "negative-infinity") return -Infinity;
  if (kind === "bigint") return 9007199254740993n;
  if (kind === "map") return new Map([["key", 1]]);
  if (kind === "circular") {
    const value = { name: "cycle" };
    value.self = value;
    return value;
  }
  if (kind === "throw") throw new RangeError("edge failure");
  if (kind === "process-control") return require("node:child_process").spawn;
  return { kind };
};

module.exports.edge = module.exports;
