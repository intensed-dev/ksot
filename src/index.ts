export type KSOTValue = null | boolean | number | string | KSOTValue[] | { [key: string]: KSOTValue };

export interface ImportResolver {
  (path: string, from?: string): string;
}

export interface KSOTPlugin {
  name: string;
  directive?: (name: string, argument: string, context: PluginContext) => void;
  type?: (name: string, rawValue: string, context: PluginContext) => KSOTValue | undefined;
}

export interface PluginContext {
  sourceName?: string;
  imports: Record<string, KSOTValue>;
}

export interface CompileOptions {
  sourceName?: string;
  resolveImport?: ImportResolver;
  plugins?: KSOTPlugin[];
}

export class KSOTError extends Error {
  constructor(message: string, public readonly line?: number, public readonly column?: number) {
    super(`${message}${line ? ` (line ${line}${column ? `, column ${column}` : ""})` : ""}`);
    this.name = "KSOTError";
  }
}

const BUILTIN_TYPES = new Set([
  "String", "Int", "Integer", "Bool", "Boolean", "Double", "Color", "Version", "Auto", "Object", "Array"
]);

export function parse(source: string, options: CompileOptions = {}): KSOTValue {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first === -1) return {};

  // A KSOT file without @ksot is deliberately JSON-compatible.
  if (lines[first].trim() !== "@ksot") {
    try { return JSON.parse(source) as KSOTValue; }
    catch (error) { throw new KSOTError(`Invalid JSON: ${(error as Error).message}`); }
  }

  const imports: Record<string, KSOTValue> = {};
  const plugins = options.plugins ?? [];
  const context: PluginContext = { sourceName: options.sourceName, imports };
  const body: string[] = [];
  let bodyStarted = false;

  for (let i = 0; i < lines.length; i++) {
    const original = lines[i];
    const trimmed = original.trim();
    if (!trimmed || trimmed === "@ksot") continue;

    if (!bodyStarted && (trimmed.startsWith("@com ") || trimmed === "@com" || trimmed.startsWith("@comment ") || trimmed === "@comment")) continue;

    const imp = trimmed.match(/^@(imp|import)\s+\{([^}]*)\}\s+from\s+["']([^"']+)["']\s*$/);
    if (imp) {
      if (!options.resolveImport) throw new KSOTError("Imports require compile options.resolveImport", i + 1, 1);
      const importedSource = options.resolveImport(imp[3], options.sourceName);
      const imported = parse(importedSource, { ...options, sourceName: imp[3] });
      if (!isObject(imported)) throw new KSOTError(`Imported file ${imp[3]} must contain an object`, i + 1, 1);
      const alias = fileStem(imp[3]);
      const selected = imp[2].split(",").map((x) => x.trim()).filter(Boolean);
      const namespace: Record<string, KSOTValue> = {};
      for (const key of selected) {
        if (!(key in imported)) throw new KSOTError(`Imported value '${key}' does not exist in ${imp[3]}`, i + 1, 1);
        namespace[key] = imported[key];
      }
      imports[alias] = namespace;
      continue;
    }

    if (trimmed.startsWith("@plugin")) {
      const argument = trimmed.slice("@plugin".length).trim();
      for (const plugin of plugins) plugin.directive?.("plugin", argument, context);
      continue;
    }

    if (trimmed.startsWith("@")) {
      let handled = false;
      const match = trimmed.match(/^@(\w+)\s*(.*)$/);
      if (match) {
        for (const plugin of plugins) {
          if (plugin.directive) { plugin.directive(match[1], match[2], context); handled = true; }
        }
      }
      if (!handled) throw new KSOTError(`Unknown directive '${trimmed.split(/\s+/)[0]}'`, i + 1, 1);
      continue;
    }

    bodyStarted = true;
    // `$` is a line-level interpolation marker. It must be the first non-whitespace character.
    body.push(trimmed.startsWith("$") ? trimmed.slice(1) : original);
  }

  const normalized = body.join("\n");
  const expanded = expandTypesAndValues(normalized, plugins, context);
  const interpolated = interpolate(expanded, imports);

  try { return JSON.parse(interpolated) as KSOTValue; }
  catch (error) {
    const message = (error as Error).message;
    throw new KSOTError(`Invalid KSOT object: ${message}`);
  }
}

export function compile(source: string, options: CompileOptions = {}): string {
  return JSON.stringify(parse(source, options), null, 2);
}

function expandTypesAndValues(input: string, plugins: KSOTPlugin[], context: PluginContext): string {
  // Typed values occur between a colon and the value: "key": Type: value.
  // This scanner handles quoted strings, arrays, objects and scalar values without rewriting strings.
  let out = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === '"') {
      const start = i++;
      while (i < input.length) {
        if (input[i] === "\\") { i += 2; continue; }
        if (input[i] === '"') { i++; break; }
        i++;
      }
      out += input.slice(start, i);
      const after = input.slice(i);
      const typed = after.match(/^(\s*:\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/);
      if (!typed) continue;
      const type = typed[2];
      if (!BUILTIN_TYPES.has(type) && !plugins.some((p) => p.type)) {
        throw new KSOTError(`Unknown type '${type}'`);
      }
      out += typed[1];
      i += typed[0].length;
      const [value, consumed] = readValue(input, i);
      const converted = convertTypedValue(type, value, plugins, context);
      out += JSON.stringify(converted);
      i += consumed;
      continue;
    }
    out += input[i++];
  }
  return out;
}

function readValue(input: string, start: number): [string, number] {
  let i = start;
  while (i < input.length && /\s/.test(input[i])) i++;
  const begin = i;
  if (input[i] === '"') {
    i++;
    while (i < input.length) {
      if (input[i] === "\\") { i += 2; continue; }
      if (input[i] === '"') { i++; break; }
      i++;
    }
  } else if (input[i] === "{" || input[i] === "[") {
    const open = input[i], close = open === "{" ? "}" : "]";
    let depth = 0, quote = false;
    for (; i < input.length; i++) {
      const c = input[i];
      if (c === "\\" && quote) { i++; continue; }
      if (c === '"') quote = !quote;
      if (!quote && c === open) depth++;
      if (!quote && c === close && --depth === 0) { i++; break; }
    }
  } else {
    while (i < input.length && !/[\n,}\]]/.test(input[i])) i++;
  }
  return [input.slice(begin, i).trim(), i - start];
}

function convertTypedValue(type: string, raw: string, plugins: KSOTPlugin[], context: PluginContext): KSOTValue {
  if (!BUILTIN_TYPES.has(type)) {
    for (const plugin of plugins) {
      const result = plugin.type?.(type, raw, context);
      if (result !== undefined) return result;
    }
    throw new KSOTError(`Unknown type '${type}'`);
  }
  if (type === "String") return parseString(raw);
  if (type === "Int" || type === "Integer") {
    const n = Number(raw); if (!Number.isInteger(n)) throw new KSOTError(`Expected integer, got '${raw}'`); return n;
  }
  if (type === "Double") {
    const n = Number(raw); if (!Number.isFinite(n)) throw new KSOTError(`Expected number, got '${raw}'`); return n;
  }
  if (type === "Bool" || type === "Boolean") {
    if (raw !== "true" && raw !== "false") throw new KSOTError(`Expected boolean, got '${raw}'`); return raw === "true";
  }
  if (type === "Color") {
    if (!/^(#[0-9a-fA-F]{6,8}|0x[0-9a-fA-F]{6,8})$/.test(raw)) throw new KSOTError(`Invalid Color '${raw}'`);
    return raw;
  }
  if (type === "Version") {
    if (!/^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(raw)) throw new KSOTError(`Invalid Version '${raw}'`);
    return raw;
  }
  if (type === "Object") {
    try { const value = JSON.parse(raw); if (!isObject(value)) throw new Error(); return value; } catch { throw new KSOTError(`Expected object, got '${raw}'`); }
  }
  if (type === "Array") {
    try { const value = JSON.parse(raw); if (!Array.isArray(value)) throw new Error(); return value; } catch { throw new KSOTError(`Expected array, got '${raw}'`); }
  }
  if (type === "Auto") {
    if (raw === "null" || raw === "unset") return null;
    return parseScalar(raw);
  }
  return null;
}

function parseScalar(raw: string): KSOTValue {
  if (raw === "null" || raw === "unset") return null;
  if (raw === "true" || raw === "false") return raw === "true";
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return Number(raw);
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1);
  return raw;
}

function parseString(raw: string): string {
  try { const value = JSON.parse(raw); if (typeof value !== "string") throw new Error(); return value; }
  catch { throw new KSOTError(`Expected string, got '${raw}'`); }
}

function interpolate(input: string, imports: Record<string, KSOTValue>): string {
  return input.replace(/\$\{([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?\}/g, (_, namespace: string, key?: string) => {
    const value = key ? (isObject(imports[namespace]) ? imports[namespace][key] : undefined) : imports[namespace];
    if (value === undefined) throw new KSOTError(`Unknown interpolation '${namespace}${key ? `.${key}` : ""}'`);
    return String(value);
  });
}

function isObject(value: KSOTValue | undefined): value is { [key: string]: KSOTValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileStem(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.(?:ksot|json)$/i, "");
}
