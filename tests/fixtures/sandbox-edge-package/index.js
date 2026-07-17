module.exports = function edgeValue(kind) {
  if (kind === "undefined") return undefined;
  if (kind === "nan") return Number.NaN;
  if (kind === "infinity") return Infinity;
  if (kind === "negative-infinity") return -Infinity;
  if (kind === "bigint") return 9007199254740993n;
  if (kind === "map") return new Map([["key", 1]]);
  if (kind === "prototype-swapped-array") {
    const target = [2, 0, 8, -5];
    Object.assign(target, JSON.parse('{"__proto__":{"necromancerProbe":true},"label":"retained"}'));
    return target;
  }
  if (kind === "unserializable") return new Proxy({}, { ownKeys() { throw new Error("proxy keys are unavailable"); } });
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
