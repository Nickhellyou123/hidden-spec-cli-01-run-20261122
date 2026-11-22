// main.ts is mend, the CLI SPEC.md specifies. It implements the whole specification: the command line, the output
// and exit codes, safe paths, format detection, line matching at three tiers (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines, with its own line break and whether it ends with one (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Line matching at three tiers (SPEC.md section 5). */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** 0-based positions where O occurs in lines at the tier, at or after `from`. */
function occurrences(O: string[], lines: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const nO = O.map((l) => normLine(l, tier));
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (normLine(lines[i + k]!, tier) !== nO[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its occurrences; null when none. */
function findTierFrom(O: string[], lines: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(O, lines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to the anchor (a single line), at the first tier with one. */
function findAnchor(anchor: string, lines: string[], strict: boolean, from = 0): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = normLine(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === want) return i;
    }
  }
  return null;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One body line of a hunk or chunk, split into old lines O and new lines N. */
interface BlockLine {
  text: string;
  /** Index into O when this is a context line, null when it is a new line. */
  ctxIdx: number | null;
}

function buildBlock(body: string[]): { O: string[]; N: BlockLine[] } {
  const O: string[] = [];
  const N: BlockLine[] = [];
  for (const bl of body) {
    if (bl === '') {
      O.push('');
      N.push({ text: '', ctxIdx: O.length - 1 });
    } else if (bl[0] === ' ') {
      const t = bl.slice(1);
      O.push(t);
      N.push({ text: t, ctxIdx: O.length - 1 });
    } else if (bl[0] === '-') {
      O.push(bl.slice(1));
    } else if (bl[0] === '+') {
      N.push({ text: bl.slice(1), ctxIdx: null });
    }
  }
  return { O, N };
}

/** Replace O at `pos` with N: context lines come from the file, new lines are re-indented at tier 2. */
function replaceLines(lines: string[], O: string[], N: BlockLine[], pos: number, tier: number): string[] {
  let repl = N.map((e) => (e.ctxIdx !== null ? lines[pos + e.ctxIdx]! : e.text));
  if (tier === 2) {
    const F = leadingWs(lines[pos]!);
    const P = leadingWs(O[0]!);
    repl = repl.map((l, i) => {
      if (N[i]!.ctxIdx !== null) return l;
      if (l === '' || /^[ \t]+$/.test(l)) return l;
      return l.startsWith(P) ? F + l.slice(P.length) : l;
    });
  }
  return [...lines.slice(0, pos), ...repl, ...lines.slice(pos + O.length)];
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  A: number;
  O: string[];
  N: BlockLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noBreak: boolean;
  hasPlus: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  lastPlusNoBreak: boolean;
}

interface UniSection {
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

function hunkFlags(body: string[]): { noBreak: boolean; hasPlus: boolean; lastPlusNoBreak: boolean } {
  let lastCtxNew = -1;
  let lastPlus = -1;
  for (let i = 0; i < body.length; i++) {
    const bl = body[i]!;
    if (bl === '' || bl[0] === ' ' || bl[0] === '+') lastCtxNew = i;
    if (bl[0] === '+') lastPlus = i;
  }
  const after = (idx: number): boolean => idx >= 0 && idx + 1 < body.length && body[idx + 1]![0] === '\\';
  return { noBreak: after(lastCtxNew), hasPlus: lastPlus >= 0, lastPlusNoBreak: after(lastPlus) };
}

function headerPath(raw: string): string | null {
  const t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

function applyUniHunk(model: FileModel, h: Hunk, d: number, strict: boolean, path: string): { model: FileModel; dDelta: number } {
  const lines = model.lines;
  if (h.O.length === 0) {
    const idx = Math.max(0, Math.min(h.A + d, lines.length));
    const ins = h.N.map((e) => e.text);
    const touchedEOF = idx === lines.length;
    return {
      model: { lines: [...lines.slice(0, idx), ...ins, ...lines.slice(idx)], br: model.br, final: touchedEOF ? !h.noBreak : model.final },
      dDelta: ins.length,
    };
  }
  const found = findTierFrom(h.O, lines, strict, 0);
  if (found === null) throw new Fail('no-match', path);
  const target = h.A - 1 + d;
  let pos = found.occ[0]!;
  let best = Math.abs(pos - target);
  for (const o of found.occ) {
    const dist = Math.abs(o - target);
    if (dist < best) {
      pos = o;
      best = dist;
    }
  }
  const newLines = replaceLines(lines, h.O, h.N, pos, found.tier);
  const touchedEOF = pos + h.O.length === lines.length;
  return {
    model: { lines: newLines, br: model.br, final: touchedEOF ? !h.noBreak : model.final },
    dDelta: h.N.length - h.O.length,
  };
}

function unifiedSectionEdit(s: UniSection, strict: boolean): Edit {
  const oldP = s.pairOld ?? s.renameOld ?? s.diffOld;
  const newP = s.pairNew ?? s.renameNew ?? s.diffNew;
  const isCreate = s.newFileMode || oldP === null;
  const isDelete = s.deletedFileMode || newP === null;
  return (tree) => {
    for (const p of [oldP, newP]) if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    if (isCreate) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus = s.hunks.flatMap((h) => h.N.filter((e) => e.ctxIdx === null).map((e) => e.text));
      let noBreak = false;
      for (let i = s.hunks.length - 1; i >= 0; i--) {
        if (s.hunks[i]!.hasPlus) {
          noBreak = s.hunks[i]!.lastPlusNoBreak;
          break;
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (oldP === null || newP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      let m = splitFile(tree.get(oldP)!);
      let d = 0;
      for (const h of s.hunks) {
        const r = applyUniHunk(m, h, d, strict, oldP);
        m = r.model;
        d += r.dDelta;
      }
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(m));
      tree.moves.push({ old: oldP, new: newP });
      return;
    }
    const p = oldP!;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    let m = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const r = applyUniHunk(m, h, d, strict, p);
      m = r.model;
      d += r.dDelta;
    }
    tree.now.set(p, joinFile(m));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  const newSection = (diffOld: string | null, diffNew: string | null): UniSection => {
    const s: UniSection = {
      pairOld: null,
      pairNew: null,
      renameOld: null,
      renameNew: null,
      diffOld,
      diffNew,
      newFileMode: false,
      deletedFileMode: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  let sec: UniSection | null = null;
  let hasPair = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      sec = newSection(m[1]!, m[2]!);
      hasPair = false;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec === null || sec.hunks.length > 0 || hasPair) {
        sec = newSection(null, null);
        hasPair = false;
      }
      sec.pairOld = headerPath(l.slice(4));
      sec.pairNew = headerPath(lines[i + 1]!.slice(4));
      hasPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && sec !== null && sec.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!hm) throw new Exit2(`error: parse ${i + 1}`);
      const A = parseInt(hm[1]!, 10);
      let k = i + 1;
      const body: string[] = [];
      while (k < n) {
        const bl = lines[k]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          k++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const { O, N } = buildBlock(body);
      const flags = hunkFlags(body);
      sec.hunks.push({ A, O, N, noBreak: flags.noBreak, hasPlus: flags.hasPlus, lastPlusNoBreak: flags.lastPlusNoBreak });
      i = k;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (l.startsWith('rename from ')) sec.renameOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) sec.renameNew = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) sec.newFileMode = true;
      else if (l.startsWith('deleted file mode')) sec.deletedFileMode = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = splitFile(before);
    const found = findTierFrom(oldLines, model.lines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const N: BlockLine[] = newLines.map((t) => ({ text: t, ctxIdx: null }));
    const newModel: FileModel = {
      lines: replaceLines(model.lines, oldLines, N, pos, found.tier),
      br: model.br,
      final: model.final,
    };
    tree.now.set(path, joinFile(newModel));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: BlockLine[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  lines: string[];
  moveTo: string | null;
  chunks: V4aChunk[];
}

function v4aSectionEdit(s: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (s.kind === 'add') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const p = s.path;
    const newP = s.moveTo;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (newP !== null && tree.get(newP) !== null) throw new Fail('exists', newP);
    const model = splitFile(before);
    let lines = model.lines;
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        const a = findAnchor(chunk.anchor, lines, strict, cursor);
        if (a === null) throw new Fail('no-match', p);
        cursor = a + 1;
      }
      if (chunk.O.length === 0) {
        const idx = chunk.eof ? lines.length : cursor;
        const ins = chunk.N.map((e) => e.text);
        lines = [...lines.slice(0, idx), ...ins, ...lines.slice(idx)];
        cursor = idx + ins.length;
        continue;
      }
      const found = findTierFrom(chunk.O, lines, strict, cursor);
      if (found === null) throw new Fail('no-match', p);
      let pos = found.occ[0]!;
      if (chunk.eof) {
        const okOcc = found.occ.filter((o) => o + chunk.O.length === lines.length);
        if (okOcc.length === 0) throw new Fail('no-match', p);
        pos = okOcc[0]!;
      }
      lines = replaceLines(lines, chunk.O, chunk.N, pos, found.tier);
      cursor = pos + chunk.N.length;
    }
    const out: FileModel = { lines, br: model.br, final: model.final };
    if (newP !== null) {
      tree.now.set(p, null);
      tree.now.set(newP, joinFile(out));
      tree.moves.push({ old: p, new: newP });
    } else {
      tree.now.set(p, joinFile(out));
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const end = last;
  while (i < end) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const kind = l.startsWith('*** Add File:')
      ? 'add'
      : l.startsWith('*** Delete File:')
        ? 'delete'
        : l.startsWith('*** Update File:')
          ? 'update'
          : null;
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = l.slice(l.indexOf(':') + 1).trim();
    const headerLine = i + 1;
    const raw: { text: string; num: number }[] = [];
    let j = i + 1;
    while (j < end) {
      const sl = lines[j]!;
      if (sl.startsWith('*** Add File:') || sl.startsWith('*** Delete File:') || sl.startsWith('*** Update File:')) break;
      raw.push({ text: sl, num: j + 1 });
      j++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    const section: V4aSection = { kind, path, headerLine, lines: [], moveTo: null, chunks: [] };
    if (kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+')) section.lines.push(r.text.slice(1));
        else if (r.text === '') section.lines.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.num}`);
      }
    } else {
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to:')) {
        section.moveTo = raw[0]!.text.slice(raw[0]!.text.indexOf(':') + 1).trim();
        idx = 1;
      }
      let cur: { anchor: string | null; eof: boolean; body: string[] } | null = null;
      let started = false;
      const flush = (): void => {
        if (cur === null) return;
        const { O, N } = buildBlock(cur.body);
        section.chunks.push({ anchor: cur.anchor, eof: cur.eof, O, N });
        cur = null;
      };
      for (; idx < raw.length; idx++) {
        const r = raw[idx]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          flush();
          const anchor = t.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          started = true;
          continue;
        }
        if (t === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.num}`);
          cur.eof = true;
          flush();
          continue;
        }
        if (t.startsWith('*** Move to:')) throw new Exit2(`error: parse ${r.num}`);
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) {
            if (started) throw new Exit2(`error: parse ${r.num}`);
            cur = { anchor: null, eof: false, body: [] };
            started = true;
          }
          cur.body.push(t);
          continue;
        }
        throw new Exit2(`error: parse ${r.num}`);
      }
      flush();
      if (section.chunks.length === 0 && section.moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
    }
    edits.push(v4aSectionEdit(section, strict));
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running (SPEC.md sections 1, 2 and 10)                              */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const used = new Set<string>();
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.old);
    const nowOld = tree.now.get(mv.old);
    const wasNew = tree.original(mv.new);
    const nowNew = tree.now.get(mv.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
      used.add(mv.old);
      used.add(mv.new);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
