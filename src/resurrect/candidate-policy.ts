const FORBIDDEN_IDENTIFIERS = new Map<string, string>([
  ["import", "imports are not allowed in zero-dependency candidate source"],
  ["require", "runtime module loading is not allowed"],
  ["createRequire", "runtime module loading is not allowed"],
  ["process", "host process access is not allowed"],
  ["module", "host module access is not allowed"],
  ["global", "host global access is not allowed"],
  ["globalThis", "host global access is not allowed"],
  ["__dirname", "filesystem path access is not allowed"],
  ["__filename", "filesystem path access is not allowed"],
  ["eval", "runtime code evaluation is not allowed"],
  ["Function", "runtime code evaluation is not allowed"],
  ["AsyncFunction", "runtime code evaluation is not allowed"],
  ["Worker", "process creation is not allowed"],
  ["SharedWorker", "process creation is not allowed"],
  ["Deno", "alternate runtime access is not allowed"],
  ["Bun", "alternate runtime access is not allowed"],
  ["fetch", "network access is not allowed"],
  ["WebSocket", "network access is not allowed"],
  ["XMLHttpRequest", "network access is not allowed"],
  ["WebAssembly", "dynamic executable loading is not allowed"]
]);

const FORBIDDEN_STRING = /(?:^node:|^file:|(?:^|[/\\])\.\.(?:[/\\]|$)|\.necromancer-cache|(?:^|[/\\])original[/\\]package(?:[/\\]|$)|(?:^|[/\\])artifacts?(?:[/\\]|$)|child_process|worker_threads|node-gyp)/i;

interface Token {
  kind: "identifier" | "string";
  value: string;
  offset: number;
}

function policyFailure(message: string, offset: number): Error {
  return new Error(`Candidate source violates the reconstruction safety policy at character ${offset + 1}: ${message}. Return a self-contained TypeScript implementation with no runtime imports or host access.`);
}

function identifierStart(character: string): boolean {
  return /[A-Za-z_$]/.test(character);
}

function identifierPart(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character);
}

function decodeEscape(source: string, index: number): { value: string; next: number } {
  const marker = source[index];
  if (marker === "x") {
    const digits = source.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(digits)) throw policyFailure("invalid hexadecimal string escape", index - 1);
    return { value: String.fromCharCode(Number.parseInt(digits, 16)), next: index + 3 };
  }
  if (marker === "u") {
    if (source[index + 1] === "{") {
      const close = source.indexOf("}", index + 2);
      const digits = close === -1 ? "" : source.slice(index + 2, close);
      if (!/^[0-9A-Fa-f]{1,6}$/.test(digits)) throw policyFailure("invalid Unicode string escape", index - 1);
      return { value: String.fromCodePoint(Number.parseInt(digits, 16)), next: close + 1 };
    }
    const digits = source.slice(index + 1, index + 5);
    if (!/^[0-9A-Fa-f]{4}$/.test(digits)) throw policyFailure("invalid Unicode string escape", index - 1);
    return { value: String.fromCharCode(Number.parseInt(digits, 16)), next: index + 5 };
  }
  const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
  return { value: simple[marker] ?? marker, next: index + 1 };
}

function readString(source: string, start: number): { token: Token; next: number } {
  const quote = source[start];
  let index = start + 1;
  let value = "";
  while (index < source.length) {
    const character = source[index];
    if (character === quote) return { token: { kind: "string", value, offset: start }, next: index + 1 };
    if (character === "\\") {
      if (index + 1 >= source.length) throw policyFailure("unterminated string escape", index);
      const decoded = decodeEscape(source, index + 1);
      value += decoded.value;
      index = decoded.next;
      continue;
    }
    if (character === "\n" || character === "\r") throw policyFailure("unterminated string literal", start);
    value += character;
    index += 1;
  }
  throw policyFailure("unterminated string literal", start);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index + 2);
      index = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      if (close === -1) throw policyFailure("unterminated block comment", index);
      index = close + 2;
      continue;
    }
    if (character === "'" || character === '"') {
      const string = readString(source, index);
      tokens.push(string.token);
      index = string.next;
      continue;
    }
    if (character === "`") throw policyFailure("template literals are not allowed because they can hide runtime expressions", index);
    if (character === "\\") throw policyFailure("escaped identifiers are not allowed", index);
    if (character.charCodeAt(0) > 127) throw policyFailure("non-ASCII code outside a string literal is not allowed", index);
    if (identifierStart(character)) {
      const start = index;
      index += 1;
      while (index < source.length && identifierPart(source[index])) index += 1;
      tokens.push({ kind: "identifier", value: source.slice(start, index), offset: start });
      continue;
    }
    index += 1;
  }
  return tokens;
}

/**
 * This is deliberately a conservative lexical policy, not a claim of complete
 * JavaScript sandboxing. Candidate code still executes only in the Docker runner.
 */
export function assertCandidateSourcePolicy(source: string): void {
  if (/^\s*\/\/\//m.test(source)) throw policyFailure("TypeScript triple-slash directives are not allowed", source.indexOf("///"));
  const tokens = tokenize(source);
  let possibleReExport = false;
  for (const token of tokens) {
    if (token.kind === "identifier") {
      if (token.value === "export") {
        possibleReExport = true;
        continue;
      }
      if (possibleReExport && token.value === "from") {
        throw policyFailure("re-exporting from another module is not allowed in zero-dependency candidate source", token.offset);
      }
      if (possibleReExport && ["default", "const", "let", "var", "function", "class", "enum", "namespace", "interface", "type"].includes(token.value)) {
        possibleReExport = false;
      }
      const reason = FORBIDDEN_IDENTIFIERS.get(token.value);
      if (reason) throw policyFailure(reason, token.offset);
      continue;
    }
    possibleReExport = false;
    if (FORBIDDEN_STRING.test(token.value)) throw policyFailure(`forbidden module or filesystem path ${JSON.stringify(token.value)}`, token.offset);
  }
}
