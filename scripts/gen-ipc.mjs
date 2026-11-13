#!/usr/bin/env node
/* Writes src/core/ipc.gen.ts from the Rust side, so every `invoke` call in the window is checked against
 * the command it names: the argument names and types, and what comes back.
 *
 *   node scripts/gen-ipc.mjs          rewrite the file
 *   node scripts/gen-ipc.mjs --check  exit 1 if the file is out of date (CI)
 *
 * It reads `#[tauri::command]` functions and the structs/enums they mention. It is a reader of this
 * repo's Rust, not a Rust parser: when it meets a type it cannot translate it stops with an error naming
 * the type, rather than writing `any`. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src-tauri', 'src');
const outFile = path.join(root, 'src', 'core', 'ipc.gen.ts');

const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.rs')).sort();
const sources = new Map(files.map((f) => [f.replace(/\.rs$/, ''), stripTests(fs.readFileSync(path.join(srcDir, f), 'utf8'))]));

/** Unit tests declare their own throwaway structs; they are not part of the bridge. */
function stripTests(src) {
  const at = src.search(/^#\[cfg\(test\)\]\s*\n\s*mod \w+ \{/m);
  return at < 0 ? src : src.slice(0, at);
}

/** Split `a: Foo<B, C>, d: E` at the commas that are not inside brackets. */
function splitTop(text, sep = ',') {
  const out = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ('<([{'.includes(ch)) depth++;
    else if (ch === '>' && text[i - 1] !== '-') depth--;
    else if (')]}'.includes(ch)) depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The text between the bracket at `open` and its match. */
function balanced(src, open) {
  const pairs = { '(': ')', '{': '}', '<': '>', '[': ']' };
  const close = pairs[src[open]];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === src[open]) depth++;
    else if (src[i] === close && !(close === '>' && src[i - 1] === '-')) {
      depth--;
      if (depth === 0) return { body: src.slice(open + 1, i), end: i };
    }
  }
  throw new Error('unbalanced bracket');
}

const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const pascal = (s) => camel(s).replace(/^./, (c) => c.toUpperCase());
function renameAll(name, rule) {
  if (!rule) return name;
  if (rule === 'camelCase') return /_/.test(name) || /^[a-z]/.test(name) ? camel(name) : name.replace(/^./, (c) => c.toLowerCase());
  if (rule === 'snake_case') return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  if (rule === 'lowercase') return name.toLowerCase();
  if (rule === 'kebab-case') return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
  if (rule === 'SCREAMING_SNAKE_CASE') return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
  throw new Error(`rename_all = "${rule}" is not handled`);
}

/* ---------------------------------------------------------------- types declared in Rust */

const decls = new Map(); // "module::Name" -> decl
const byName = new Map(); // "Name" -> [keys]

function attrsBefore(src, at) {
  // the run of `#[...]` and `///` lines directly above a declaration
  const lines = src.slice(0, at).split('\n');
  const out = [];
  for (let i = lines.length - 2; i >= 0; i--) {
    const l = lines[i].trim();
    if (l.startsWith('#[') || l.startsWith('///') || l.startsWith('//')) out.unshift(l);
    else if (l.endsWith(')]') || l.endsWith(',')) out.unshift(l);
    else break;
  }
  return out.join('\n');
}
const serdeOf = (attrs) => [...attrs.matchAll(/#\[serde\(([^\]]*)\)\]/g)].map((m) => m[1]).join(', ');
const opt = (serde, key) => {
  const m = new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`).exec(serde);
  return m ? m[1] : null;
};

for (const [mod, src] of sources) {
  for (const m of src.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(struct|enum)\s+(\w+)\s*(\{|\(|;)/gm)) {
    const [, kind, name, opener] = m;
    const attrs = attrsBefore(src, m.index + m[0].length);
    const serde = serdeOf(attrs);
    const open = m.index + m[0].length - 1;
    const body = opener === ';' ? '' : balanced(src, open).body;
    const key = `${mod}::${name}`;
    decls.set(key, { key, mod, name, kind, tuple: opener === '(', body, serde, attrs });
    (byName.get(name) || byName.set(name, []).get(name)).push(key);
  }
}

function fieldsOf(body) {
  // strip comments, then split into `attrs name: Type`
  const clean = body.replace(/\/\/[^\n]*/g, '');
  return splitTop(clean).map((chunk) => {
    const serde = serdeOf(chunk);
    const rest = chunk.replace(/#\[[^\]]*\]/g, '').trim();
    const m = /^(?:pub(?:\([^)]*\))?\s+)?(?:r#)?(\w+)\s*:\s*([\s\S]+)$/.exec(rest);
    return m ? { name: m[1], type: m[2].trim(), serde } : null;
  }).filter(Boolean);
}

/* ---------------------------------------------------------------- Rust type -> TypeScript */

const used = new Map(); // key -> ts name
const NUMBERS = new Set(['u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'f32', 'f64']);
const STRINGS = new Set(['String', 'str', 'PathBuf', 'Path', 'char', 'OsString', 'Url']);

function tsName(key) {
  if (used.has(key)) return used.get(key);
  const d = decls.get(key);
  const name = byName.get(d.name).length > 1 ? pascal(d.mod) + d.name : d.name;
  used.set(key, name);
  return name;
}

function resolve(typePath, mod) {
  const parts = typePath.split('::').filter((p) => p !== 'crate' && p !== 'self' && p !== 'super');
  const name = parts[parts.length - 1];
  const keys = byName.get(name);
  if (!keys) return null;
  if (parts.length > 1 && decls.has(`${parts[parts.length - 2]}::${name}`)) return `${parts[parts.length - 2]}::${name}`;
  if (decls.has(`${mod}::${name}`)) return `${mod}::${name}`;
  if (keys.length === 1) return keys[0];
  throw new Error(`type ${typePath} (used in ${mod}.rs) is declared in more than one module: ${keys.join(', ')}`);
}

function ts(type, mod, where) {
  let t = type.trim().replace(/^&\s*(?:'\w+\s+)?(?:mut\s+)?/, '').trim();
  if (t === '()' || t === '') return 'void';
  if (t === 'bool') return 'boolean';
  if (NUMBERS.has(t)) return 'number';
  if (t.startsWith('(')) return `[${splitTop(balanced(t, 0).body).map((x) => ts(x, mod, where)).join(', ')}]`;
  if (t.startsWith('[')) return `${wrap(ts(t.slice(1, -1).split(';')[0], mod, where))}[]`;
  const g = /^([\w:]+)\s*<([\s\S]+)>$/.exec(t);
  if (g) {
    const head = g[1].split('::').pop();
    const args = splitTop(g[2]);
    if (head === 'Option') return `${ts(args[0], mod, where)} | null`;
    if (head === 'Vec' || head === 'VecDeque' || head === 'HashSet' || head === 'BTreeSet') return `${wrap(ts(args[0], mod, where))}[]`;
    if (head === 'Result') return ts(args[0], mod, where);
    if (head === 'HashMap' || head === 'BTreeMap') return `Record<string, ${ts(args[1], mod, where)}>`;
    if (head === 'Box' || head === 'Arc' || head === 'Rc' || head === 'Cow') return ts(args[args.length - 1], mod, where);
    throw new Error(`${where}: generic type ${t} is not handled`);
  }
  const last = t.split('::').pop();
  if (STRINGS.has(last)) return 'string';
  if (last === 'Value') return 'JsonValue';
  const key = resolve(t, mod);
  if (!key) throw new Error(`${where}: type ${t} is not declared in src-tauri/src`);
  return tsName(key);
}
const wrap = (t) => (/[|&]/.test(t) ? `(${t})` : t);

function emitDecl(key) {
  const d = decls.get(key);
  const name = used.get(key);
  const where = `${d.mod}::${d.name}`;
  const rule = opt(d.serde, 'rename_all');
  const doc = `/** \`${where}\` in src-tauri/src/${d.mod}.rs */\n`;
  if (d.kind === 'struct') {
    if (d.tuple) {
      const parts = splitTop(d.body.replace(/\/\/[^\n]*/g, '')).map((p) => ts(p.replace(/^pub(?:\([^)]*\))?\s+/, ''), d.mod, where));
      return `${doc}export type ${name} = ${parts.length === 1 ? parts[0] : `[${parts.join(', ')}]`};\n`;
    }
    const lines = fieldsOf(d.body).filter((f) => !/\bskip\b(?!_)/.test(f.serde)).map((f) => {
      const key2 = opt(f.serde, 'rename') || renameAll(f.name, rule);
      const optional = /\bdefault\b/.test(f.serde) || /\bskip_serializing_if\b/.test(f.serde) || (/\bdefault\b/.test(d.serde.replace(/rename_all[^,]*/, '')) );
      const safe = /^[A-Za-z_$][\w$]*$/.test(key2) ? key2 : JSON.stringify(key2);
      return `  ${safe}${optional ? '?' : ''}: ${ts(f.type, d.mod, `${where}.${f.name}`)};`;
    });
    return `${doc}export interface ${name} {\n${lines.join('\n')}\n}\n`;
  }
  // enum
  const tag = opt(d.serde, 'tag');
  const untagged = /\buntagged\b/.test(d.serde);
  const variants = splitTop(d.body.replace(/\/\/[^\n]*/g, '')).map((chunk) => {
    const serde = serdeOf(chunk);
    const rest = chunk.replace(/#\[[^\]]*\]/g, '').trim();
    const m = /^(\w+)\s*([({])?/.exec(rest);
    const vname = opt(serde, 'rename') || renameAll(m[1], rule);
    if (!m[2]) return untagged ? 'null' : tag ? `{ ${tag}: ${JSON.stringify(vname)} }` : JSON.stringify(vname);
    const inner = balanced(rest, rest.indexOf(m[2])).body;
    let shape;
    if (m[2] === '(') {
      const parts = splitTop(inner).map((p) => ts(p, d.mod, `${where}::${m[1]}`));
      shape = parts.length === 1 ? parts[0] : `[${parts.join(', ')}]`;
    } else {
      const vrule = opt(serde, 'rename_all');
      shape = `{ ${fieldsOf(inner).map((f) => `${opt(f.serde, 'rename') || renameAll(f.name, vrule)}: ${ts(f.type, d.mod, `${where}::${m[1]}.${f.name}`)}`).join('; ')} }`;
    }
    if (untagged) return shape;
    if (tag) return m[2] === '{' ? `{ ${tag}: ${JSON.stringify(vname)}; ${shape.slice(2)}` : `{ ${tag}: ${JSON.stringify(vname)} } & ${shape}`;
    return `{ ${/^[A-Za-z_$][\w$]*$/.test(vname) ? vname : JSON.stringify(vname)}: ${shape} }`;
  });
  return `${doc}export type ${name} =\n${variants.map((v) => `  | ${v}`).join('\n')};\n`;
}

/* ---------------------------------------------------------------- commands */

const HOST_ARG = /\b(State|AppHandle|Window|WebviewWindow|Webview|Channel|Request)\b/;
const commands = [];
for (const [mod, src] of sources) {
  for (const m of src.matchAll(/#\[tauri::command(?:\(([^)]*)\))?\]\s*((?:#\[[^\]]*\]\s*)*)(?:pub(?:\([^)]*\))?\s+)?(async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g)) {
    const [, cmdOpts = '', , , name] = m;
    const open = m.index + m[0].length - 1;
    const { body, end } = balanced(src, open);
    const after = src.slice(end + 1, src.indexOf('{', end));
    const ret = /->\s*([\s\S]+?)\s*(?:where[\s\S]*)?$/.exec(after.trim());
    const snake = /rename_all\s*=\s*"snake_case"/.test(cmdOpts);
    const doc = attrsBefore(src, m.index + 1).split('\n').filter((l) => l.startsWith('///')).map((l) => l.replace(/^\/\/\/ ?/, '')).join(' ').replace(/\*\//g, '* /').trim();
    const args = splitTop(body.replace(/\/\/[^\n]*/g, '')).map((a) => {
      const mm = /^(?:#\[[^\]]*\]\s*)*(?:mut\s+)?(\w+)\s*:\s*([\s\S]+)$/.exec(a);
      if (!mm) throw new Error(`${mod}::${name}: cannot read argument "${a}"`);
      return { name: mm[1], type: mm[2].trim() };
    }).filter((a) => !HOST_ARG.test(a.type));
    commands.push({ mod, name, doc, args: args.map((a) => ({ key: snake ? a.name : camel(a.name), optional: /^Option\s*</.test(a.type), type: ts(a.type, mod, `${mod}::${name}(${a.name})`) })), ret: ret ? ts(ret[1], mod, `${mod}::${name} return`) : 'void' });
  }
}
commands.sort((a, b) => a.name.localeCompare(b.name));

/* Everything registered with the app must be described, and nothing else. */
const lib = sources.get('lib');
const handler = balanced(lib, lib.indexOf('[', lib.indexOf('tauri::generate_handler!'))).body;
const registered = new Set(splitTop(handler.replace(/\/\/[^\n]*/g, '')).map((p) => p.split('::').pop().trim()).filter(Boolean));
const found = new Set(commands.map((c) => c.name));
const missing = [...registered].filter((n) => !found.has(n));
if (missing.length) throw new Error(`registered in generate_handler! but no #[tauri::command] was found for: ${missing.join(', ')}`);
const live = commands.filter((c) => registered.has(c.name));

// emit declarations until no new ones appear (a struct can mention another struct)
const emitted = new Map();
for (;;) {
  const todo = [...used.keys()].filter((k) => !emitted.has(k));
  if (!todo.length) break;
  for (const k of todo) emitted.set(k, emitDecl(k));
}

let out = `/* GENERATED by scripts/gen-ipc.mjs from src-tauri/src/*.rs. Do not edit: run \`npm run ipc\`.
 * CI runs the generator with --check, so a Rust command that changes without this file fails the build. */

/** Anything JSON can hold. Used where the Rust side passes \`serde_json::Value\` through untouched. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

`;
out += [...emitted.entries()].sort((a, b) => used.get(a[0]).localeCompare(used.get(b[0]))).map(([, text]) => text).join('\n');
out += `\n/** Every command the window may call: its arguments (\`args\`) and what it resolves to (\`result\`). */\nexport interface Commands {\n`;
for (const c of live) {
  const args = c.args.length ? `{ ${c.args.map((a) => `${a.key}${a.optional ? '?' : ''}: ${a.type}`).join('; ')} }` : 'Record<string, never>';
  out += `${c.doc ? `  /** ${c.doc} (${c.mod}.rs) */\n` : `  /** ${c.mod}.rs */\n`}  ${c.name}: { args: ${args}; result: ${c.ret} };\n`;
}
out += `}\n\n/** Command names, for the check that the window never calls one that does not exist. */\nexport const COMMAND_NAMES = [\n${live.map((c) => `  '${c.name}'`).join(',\n')}\n] as const;\n`;

if (process.argv.includes('--check')) {
  const have = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  if (have !== out) {
    console.error('src/core/ipc.gen.ts is out of date with the Rust commands. Run: npm run ipc');
    process.exit(1);
  }
  console.log(`ipc.gen.ts is up to date (${live.length} commands, ${emitted.size} types).`);
} else {
  fs.writeFileSync(outFile, out);
  console.log(`wrote src/core/ipc.gen.ts: ${live.length} commands, ${emitted.size} types.`);
}
