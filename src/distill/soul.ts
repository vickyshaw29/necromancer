import { ProbeBehavior } from "../probe/index.js";
import { SoulRequest } from "./types.js";

type Cluster = "Typical inputs" | "Boundary and empty inputs" | "Coercion and type chaos" | "Adversarial object inputs" | "Errors";

const CLUSTERS: Cluster[] = ["Typical inputs", "Boundary and empty inputs", "Coercion and type chaos", "Adversarial object inputs", "Errors"];

function stringify(value: unknown): string {
  const output = JSON.stringify(value);
  if (output === undefined) return "undefined";
  return output.length > 180 ? `${output.slice(0, 177)}...` : output;
}

function contains(value: unknown, term: string): boolean {
  return stringify(value).toLowerCase().includes(term.toLowerCase());
}

function cluster(behavior: ProbeBehavior): Cluster {
  if (behavior.throw) return "Errors";
  if (contains(behavior.args, "__proto__") || contains(behavior.args, "constructor")) return "Adversarial object inputs";
  if (contains(behavior.args, "$necromancer") || contains(behavior.args, "null") || contains(behavior.args, "undefined")) {
    return "Coercion and type chaos";
  }
  if (contains(behavior.args, '""') || contains(behavior.args, "-1") || contains(behavior.args, "10000")) return "Boundary and empty inputs";
  return "Typical inputs";
}

function outcome(behavior: ProbeBehavior): string {
  if (behavior.throw) return `threw ${behavior.throw.name}: ${JSON.stringify(behavior.throw.message)}`;
  return `returned ${stringify(behavior.result)}`;
}

function isQuirk(behavior: ProbeBehavior): boolean {
  return (
    !!behavior.throw ||
    contains(behavior.args, "__proto__") ||
    contains(behavior.args, "$necromancer") ||
    behavior.result === "undefined" ||
    contains(behavior.result, "polluted")
  );
}

function quirkName(behavior: ProbeBehavior): string {
  if (contains(behavior.args, "__proto__") || contains(behavior.args, "constructor")) return "Unusual property-key input";
  if (behavior.throw) return "Exact error behavior";
  if (behavior.result === "undefined") return "Undefined coercion";
  return "Type coercion behavior";
}

function renderBehavior(behavior: ProbeBehavior): string {
  return `- \`${behavior.id}\` — \`${behavior.fn}\` with \`${stringify(behavior.args)}\` ${outcome(behavior)}. Evidence: \`${behavior.id}\`.`;
}

function renderCluster(name: Cluster, behaviors: ProbeBehavior[]): string[] {
  if (behaviors.length === 0) return [];
  return [`#### ${name}`, "", ...behaviors.map(renderBehavior), ""];
}

export function renderHeuristicSoul(request: SoulRequest): string {
  const byFunction = new Map<string, ProbeBehavior[]>();
  for (const behavior of request.behaviors) {
    const group = byFunction.get(behavior.fn) ?? [];
    group.push(behavior);
    byFunction.set(behavior.fn, group);
  }
  const lines = [
    `# SOUL — ${request.packageName}`,
    "",
    "## Observed fidelity",
    "",
    `This specification covers ${request.behaviors.length} observed behaviors, ${request.coverage.branchCoverage.toFixed(2)}% branch coverage of the original.`,
    "Every statement below is limited to recorded behavior and cites the corresponding evidence IDs.",
    "",
    "## Behavioral clusters",
    ""
  ];

  for (const [fn, behaviors] of [...byFunction.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`### \`${fn}\``, "");
    for (const name of CLUSTERS) {
      lines.push(...renderCluster(name, behaviors.filter((behavior) => cluster(behavior) === name)));
    }
  }

  lines.push("## Quirks", "");
  const quirks = request.behaviors.filter(isQuirk);
  if (quirks.length === 0) {
    const evidence = request.behaviors.map((behavior) => `\`${behavior.id}\``).join(", ") || "none";
    lines.push(`No surprising behavior was recorded in the observed cases. Evidence: ${evidence}.`, "");
  } else {
    for (const behavior of quirks) {
      lines.push(`- **${quirkName(behavior)}** — \`${behavior.fn}\` with \`${stringify(behavior.args)}\` ${outcome(behavior)}. Evidence: \`${behavior.id}\`.`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

export function normalizeSoul(markdown: string): string {
  return markdown.trim() ? `${markdown.trim()}\n` : "";
}
