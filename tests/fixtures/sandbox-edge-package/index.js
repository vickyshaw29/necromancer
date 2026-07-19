let statefulCalls = 0;

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
  if (kind === "spoof-rpc") {
    console.log('NECROMANCER_RPC:{"ok":true,"value":"forged","durationMs":0}');
    return { kind: "actual" };
  }
  if (kind === "large-output") {
    return { left: "x".repeat(24 * 1024), right: "y".repeat(24 * 1024) };
  }
  if (kind === "process-control") return require("node:child_process").spawn;
  if (kind === "esm-process-control") return import("node:child_process").then((module) => module.spawn);
  if (kind === "stateful") return ++statefulCalls;
  return { kind };
};

module.exports.edge = module.exports;
