module.exports = function edgeValue(kind) {
  if (kind === "undefined") return undefined;
  if (kind === "nan") return Number.NaN;
  if (kind === "infinity") return Infinity;
  if (kind === "negative-infinity") return -Infinity;
  if (kind === "bigint") return 9007199254740993n;
  if (kind === "circular") {
    const value = { name: "cycle" };
    value.self = value;
    return value;
  }
  if (kind === "throw") throw new RangeError("edge failure");
  return { kind };
};
