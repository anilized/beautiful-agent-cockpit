import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Lint for the Pixel Garage package: no image files, colour literals only in palette.ts, relative `.js` imports only (`@cockpit/*` as
// `import type`), no HTML built from data, and nothing but GET on the network. Each rule is a pure function over (file name, source),
// shown to fail on violating samples below, then run over the real tree.

const GARAGE = fileURLToPath(new URL('../packages/garage', import.meta.url));
const PALETTE = 'src/palette.ts';

// ---------- the tree ----------

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out.sort();
}

const IMAGE_EXTS = new Set([
  '.png', '.apng', '.jpg', '.jpeg', '.jfif', '.pjpeg', '.pjp', '.gif', '.svg', '.svgz', '.webp', '.avif', '.ico', '.cur', '.bmp',
  '.tif', '.tiff', '.heic', '.heif', '.jxl', '.psd',
]);
const CODE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);

// ---------- rule 1: no image files ----------

function imageViolations(files: string[]): string[] {
  return files.filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase())).map((f) => `${f}: image file`);
}

// ---------- rule 2: colour literals only in palette.ts ----------

const NAMED_COLOURS = new Set(
  ('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse '
    + 'chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki '
    + 'darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey '
    + 'darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro '
    + 'ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush '
    + 'lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon '
    + 'lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon '
    + 'mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise '
    + 'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid '
    + 'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red '
    + 'rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow '
    + 'springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' '),
);

const HEX_COLOUR = /(?<![\w&])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
// rgb()/hsl()/hwb() always; lab()/lch() only with a colour-like first argument, so a method named `lab(` is not a hit.
const COLOUR_FN = /(?<![\w.$-])(?:(?:rgba?|hsla?|hwb|color-mix)\(|(?:ok)?(?:lab|lch)\(\s*(?=[-+.\d$]|none|from))/gi;
/** A CSS property that takes a colour. */
const COLOUR_PROP = /color|background|border|outline|fill|stroke|shadow|caret|accent/i;
/** A JS property or variable name that holds a colour: `fillStyle`, `.color`, `style.background`, `shadowColor` ... */
const COLOUR_NAME = /(?:^|[.\s])(?:\w*(?:colou?r|background|fillStyle|strokeStyle)\w*)$/i;

/** Named colours inside the declarations of a piece of CSS (`color: red`, `border: 1px solid tan`). `var(--g-red)` is not one. */
function cssNamedColours(css: string): string[] {
  const hits: string[] = [];
  for (const m of css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/gi)) {
    if (!COLOUR_PROP.test(m[1]!)) continue;
    for (const tok of m[2]!.toLowerCase().split(/[^a-z0-9#-]+/)) if (NAMED_COLOURS.has(tok)) hits.push(`${m[1]!.trim()}: ${tok}`);
  }
  return hits;
}

function stringValue(n: ts.Node): string | null {
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null;
}

/** Named colours that code assigns: `ctx.fillStyle = 'red'`, `{ color: 'red' }`, `setProperty('color', 'red')`, `'color: red'`. */
function tsNamedColours(sf: ts.SourceFile): string[] {
  const hits: string[] = [];
  const named = (v: string | null): v is string => v !== null && NAMED_COLOURS.has(v.trim().toLowerCase());
  const visit = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const v = stringValue(n.right);
      if (named(v) && COLOUR_NAME.test(n.left.getText(sf))) hits.push(`${n.left.getText(sf)} = '${v}'`);
    } else if (ts.isPropertyAssignment(n)) {
      const v = stringValue(n.initializer);
      if (named(v) && COLOUR_NAME.test(n.name.getText(sf).replace(/^['"]|['"]$/g, ''))) hits.push(`${n.name.getText(sf)}: '${v}'`);
    } else if (ts.isCallExpression(n) && n.arguments.length >= 2 && /(?:^|\.)(?:setProperty|setAttribute)$/.test(n.expression.getText(sf))) {
      const k = stringValue(n.arguments[0]!);
      const v = stringValue(n.arguments[1]!);
      if (k !== null && named(v) && COLOUR_PROP.test(k)) hits.push(`${k} -> '${v}'`);
    } else {
      const text = stringValue(n);
      if (text !== null && text.includes(':')) hits.push(...cssNamedColours(text));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

/** The CSS that an HTML page carries: `<style>` blocks and `style=""` attributes. */
function htmlCss(html: string): string {
  const parts: string[] = [];
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) parts.push(m[1]!);
  for (const m of html.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) parts.push(m[1] ?? m[2] ?? '');
  return parts.join('\n');
}

function colourViolations(file: string, src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(HEX_COLOUR)) out.push(`${file}: hex colour ${m[0]}`);
  for (const m of src.matchAll(COLOUR_FN)) out.push(`${file}: colour function ${m[0]}`);
  const ext = extname(file).toLowerCase();
  if (CODE_EXTS.has(ext)) {
    for (const h of tsNamedColours(ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true))) out.push(`${file}: named colour ${h}`);
  } else if (ext === '.css') {
    for (const h of cssNamedColours(src)) out.push(`${file}: named colour ${h}`);
  } else if (ext === '.html' || ext === '.htm') {
    for (const h of cssNamedColours(htmlCss(src))) out.push(`${file}: named colour ${h}`);
    for (const m of src.matchAll(/\s(?:fill|stroke|color|bgcolor|stop-color)\s*=\s*["']\s*([a-z]+)\s*["']/gi)) {
      if (NAMED_COLOURS.has(m[1]!.toLowerCase())) out.push(`${file}: named colour attribute ${m[0].trim()}`);
    }
  }
  return out;
}

// ---------- rule 3: imports ----------

function parse(file: string, src: string): ts.SourceFile {
  return ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
}

/** `type` is true for `import type` / `export type ... from` / `import('x').T` positions, which are erased. */
function checkSpecifier(file: string, spec: string, type: boolean, out: string[]): void {
  if (spec.startsWith('node:')) out.push(`${file}: node: import '${spec}'`);
  else if (spec.startsWith('@cockpit/')) {
    if (!type) out.push(`${file}: non-type @cockpit import '${spec}' (use import type)`);
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    if (!spec.endsWith('.js')) out.push(`${file}: relative import '${spec}' must end in .js`);
  } else out.push(`${file}: import '${spec}' is neither relative nor type-only @cockpit`);
}

function importViolations(file: string, src: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      checkSpecifier(file, n.moduleSpecifier.text, !!n.importClause?.isTypeOnly, out);
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      checkSpecifier(file, n.moduleSpecifier.text, n.isTypeOnly, out);
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      const e = n.moduleReference.expression;
      if (ts.isStringLiteral(e)) checkSpecifier(file, e.text, n.isTypeOnly, out);
    } else if (ts.isImportTypeNode(n)) {
      const lit = ts.isLiteralTypeNode(n.argument) ? n.argument.literal : null;
      if (lit && ts.isStringLiteral(lit)) checkSpecifier(file, lit.text, true, out);
    } else if (ts.isCallExpression(n)) {
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = n.arguments[0];
        if (arg && ts.isStringLiteral(arg)) checkSpecifier(file, arg.text, false, out);
        else out.push(`${file}: dynamic import with a non-literal specifier`);
      } else if (ts.isIdentifier(n.expression) && n.expression.text === 'require') out.push(`${file}: require() call`);
    }
    ts.forEachChild(n, visit);
  };
  visit(parse(file, src));
  return out;
}

// ---------- rule 4: no HTML built from data ----------

const HTML_SINKS = new Set(['innerHTML', 'outerHTML']);
const HTML_CALLS = new Set(['insertAdjacentHTML', 'setHTMLUnsafe', 'write', 'writeln']);

/** Assigning `innerHTML` (and friends) is fine only with a plain string literal; anything computed could carry data. */
function innerHtmlViolations(file: string, src: string): string[] {
  const sf = parse(file, src);
  const out: string[] = [];
  const literal = (n: ts.Node): boolean => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
  const sink = (n: ts.Node): string | null => {
    if (ts.isPropertyAccessExpression(n) && HTML_SINKS.has(n.name.text)) return n.name.text;
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && HTML_SINKS.has(n.argumentExpression.text)) {
      return n.argumentExpression.text;
    }
    return null;
  };
  const visit = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const s = sink(n.left);
      if (s && !literal(n.right)) out.push(`${file}: ${s} assigned non-literal data: ${n.right.getText(sf).slice(0, 60)}`);
    } else if (ts.isPropertyAssignment(n) && HTML_SINKS.has(n.name.getText(sf).replace(/^['"]|['"]$/g, '')) && !literal(n.initializer)) {
      out.push(`${file}: ${n.name.getText(sf)} set to non-literal data in an object literal`);
    } else if (ts.isShorthandPropertyAssignment(n) && HTML_SINKS.has(n.name.text)) {
      out.push(`${file}: ${n.name.text} set to non-literal data in an object literal`);
    } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && HTML_CALLS.has(n.expression.name.text)) {
      const name = n.expression.name.text;
      const isDocWrite = (name === 'write' || name === 'writeln') && n.expression.expression.getText(sf) === 'document';
      if (name !== 'write' && name !== 'writeln' || isDocWrite) {
        const html = name === 'insertAdjacentHTML' ? n.arguments[1] : n.arguments[0];
        if (!html || !literal(html)) out.push(`${file}: ${isDocWrite ? 'document.' : ''}${name}() called with non-literal data`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ---------- rule 5: GET only ----------

const WRITE_METHODS = /^(?:POST|PUT|PATCH|DELETE)$/i;

/** No request method but GET, and no POST (or other write method) anywhere in the code, even as a string or a type. */
function networkViolations(file: string, src: string): string[] {
  const sf = parse(file, src);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    const v = stringValue(n);
    if (v !== null && WRITE_METHODS.test(v.trim())) out.push(`${file}: '${v}' request method`);
    if (ts.isPropertyAssignment(n) && n.name.getText(sf).replace(/^['"]|['"]$/g, '') === 'method') {
      const m = stringValue(n.initializer);
      if (m === null) out.push(`${file}: method is not a string literal: ${n.initializer.getText(sf).slice(0, 40)}`);
      else if (m.trim().toUpperCase() !== 'GET') out.push(`${file}: method '${m}'`);
    } else if (ts.isShorthandPropertyAssignment(n) && n.name.text === 'method') {
      out.push(`${file}: method is not a string literal (shorthand)`);
    } else if (ts.isIdentifier(n) && n.text === 'XMLHttpRequest') {
      out.push(`${file}: XMLHttpRequest`);
    } else if (ts.isPropertyAccessExpression(n) && n.name.text === 'sendBeacon') {
      out.push(`${file}: sendBeacon (always a POST)`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ---------- the rules, shown to fail on samples ----------

describe('lint rules reject violating samples', () => {
  it('image files: any raster or vector image extension, any case, any depth', () => {
    for (const f of ['a.png', 'src/b.JPG', 'src/img/c.jpeg', 'd.gif', 'e.svg', 'f.webp', 'g.ico', 'h.bmp', 'i.avif', 'j.tiff']) {
      expect(imageViolations([f]), f).toHaveLength(1);
    }
    expect(imageViolations(['src/main.ts', 'src/index.html', 'package.json', 'README.md', 'src/png.ts', 'src/svg/x.ts'])).toEqual([]);
  });

  it('colours: hex in all lengths, colour functions, and named colours in CSS and in code', () => {
    const bad: Array<[string, string, string]> = [
      ['x.ts', "const c = '#fff';", 'hex colour #fff'],
      ['x.ts', "ctx.fillStyle = '#1a2B3c';", 'hex colour #1a2B3c'],
      ['x.ts', 'const c = `#12345678`;', 'hex colour #12345678'],
      ['x.ts', "const c = 'rgb(1, 2, 3)';", 'colour function rgb('],
      ['x.ts', 'const c = `rgba(${r}, 0, 0, .5)`;', 'colour function rgba('],
      ['x.ts', "const c = 'hsl(10 20% 30%)';", 'colour function hsl('],
      ['x.ts', "const c = 'hsla(10, 20%, 30%, 1)';", 'colour function hsla('],
      ['x.ts', "const c = 'oklch(0.7 0.1 200)';", 'colour function oklch('],
      ['x.ts', "ctx.fillStyle = 'red';", "named colour ctx.fillStyle = 'red'"],
      ['x.ts', "ctx.strokeStyle = ' White ';", 'named colour ctx.strokeStyle'],
      ['x.ts', "el.style.color = 'tomato';", 'named colour el.style.color'],
      ['x.ts', "const s = { background: 'navy' };", "named colour background: 'navy'"],
      ['x.ts', "el.style.setProperty('border-color', 'gold');", "named colour border-color -> 'gold'"],
      ['x.ts', "el.style.cssText = 'color: red; top: 0';", 'named colour color: red'],
      ['x.ts', "el.style.cssText = 'border: 1px solid tan';", 'named colour border: tan'],
      ['x.html', '<p style="color: #abc">x</p>', 'hex colour #abc'],
      ['x.html', '<style>a { color: rgb(0,0,0) }</style>', 'colour function rgb('],
      ['x.html', '<style>a { color: red }</style>', 'named colour color: red'],
      ['x.html', '<style>a { background: var(--g-bg) url(x) white }</style>', 'named colour background: white'],
      ['x.html', '<div style="background-color:teal">x</div>', 'named colour background-color: teal'],
      ['x.html', '<rect fill="red"></rect>', 'named colour attribute'],
      ['x.css', 'a { outline: 2px solid hotpink; }', 'named colour outline: hotpink'],
    ];
    for (const [file, src, frag] of bad) {
      const v = colourViolations(file, src);
      expect(v.length, `${file}: ${src}`).toBeGreaterThan(0);
      expect(v.join('\n'), `${file}: ${src}`).toContain(frag);
    }
  });

  it('colours: tokens, ids, entities, method calls and prose are not colours', () => {
    const good: Array<[string, string]> = [
      ['x.ts', "ctx.fillStyle = pal.base.bgDeep; el.style.setProperty('color', 'var(--g-text)');"],
      ['x.ts', "const label = 'red'; const status = { color: look.color(pal.base) };"],
      ['x.ts', "const m = 'the #fps flag, issue #12, &#169; and a#abc';"],
      ['x.ts', "const t = 'background: var(--g-bg)'; const v = foo.hsl(1); const o = { lab(p) { return p; } };"],
      ['x.html', '<style>#g-hud { color: var(--g-text); border: 1px solid var(--g-border); background: none; }</style><div id="g-hud"></div>'],
      ['x.html', '<style>.a { background: transparent; color: currentColor; color: inherit }</style><p style="top: 0">red white</p>'],
      ['x.html', '<canvas id="abc"></canvas><a href="#top">red</a>'],
    ];
    for (const [file, src] of good) expect(colourViolations(file, src), `${file}: ${src}`).toEqual([]);
  });

  it('imports: node:, bare, extension-less, non-type @cockpit, require and computed imports', () => {
    const bad: Array<[string, string]> = [
      ["import { readFileSync } from 'node:fs';", "node: import 'node:fs'"],
      ["import 'node:path';", "node: import 'node:path'"],
      ["export * from 'node:url';", "node: import 'node:url'"],
      ["const fs = await import('node:fs');", "node: import 'node:fs'"],
      ["import fs from 'fs';", "import 'fs' is neither"],
      ["import x from 'esbuild';", "import 'esbuild' is neither"],
      ["import { a } from './a';", "'./a' must end in .js"],
      ["import { a } from '../b/c.ts';", "'../b/c.ts' must end in .js"],
      ["export { a } from './a.mjs';", "'./a.mjs' must end in .js"],
      ["import { Snapshot } from '@cockpit/orchestrator';", "non-type @cockpit import '@cockpit/orchestrator'"],
      ["import { type Snapshot } from '@cockpit/orchestrator';", "non-type @cockpit import '@cockpit/orchestrator'"],
      ["import '@cockpit/core';", "non-type @cockpit import '@cockpit/core'"],
      ["export { x } from '@cockpit/core';", "non-type @cockpit import '@cockpit/core'"],
      ["const m = await import('@cockpit/core');", "non-type @cockpit import '@cockpit/core'"],
      ["const m = await import('./a');", "'./a' must end in .js"],
      ['const m = await import(name);', 'non-literal specifier'],
      ["const m = require('./a.js');", 'require() call'],
      ["import fs = require('fs');", "import 'fs' is neither"],
      ["import type { A } from 'zod';", "import 'zod' is neither"],
      ["import type { A } from './a';", "'./a' must end in .js"],
    ];
    for (const [src, frag] of bad) {
      const v = importViolations('x.ts', src);
      expect(v.length, src).toBeGreaterThan(0);
      expect(v.join('\n'), src).toContain(frag);
    }
  });

  it('imports: relative .js specifiers and type-only @cockpit imports are fine', () => {
    const good = [
      "import { a } from './a.js';",
      "import type { B } from '../b.js';",
      "export { c } from './c.js'; export * from './d.js';",
      "import './side.js';",
      "const m = await import('./lazy.js');",
      "import type { Snapshot } from '@cockpit/orchestrator';",
      "import type { CockpitEvent } from '@cockpit/core';",
      "export type { X } from '@cockpit/core';",
      "type T = import('@cockpit/core').CockpitEvent;",
      "// import fs from 'node:fs'\nconst s = \"import x from 'fs'\";",
    ];
    for (const src of good) expect(importViolations('x.ts', src), src).toEqual([]);
  });

  it('innerHTML: assignment, +=, outerHTML, bracket access, insertAdjacentHTML and document.write with data', () => {
    const bad: Array<[string, string]> = [
      ['el.innerHTML = data;', 'innerHTML assigned non-literal'],
      ['el.innerHTML = `<b>${name}</b>`;', 'innerHTML assigned non-literal'],
      ["el.innerHTML = '<b>' + name + '</b>';", 'innerHTML assigned non-literal'],
      ['el.innerHTML += text;', 'innerHTML assigned non-literal'],
      ['el.outerHTML = html(x);', 'outerHTML assigned non-literal'],
      ["el['innerHTML'] = x;", 'innerHTML assigned non-literal'],
      ['Object.assign(el, { innerHTML: x });', 'innerHTML set to non-literal'],
      ['Object.assign(el, { innerHTML });', 'innerHTML set to non-literal'],
      ["el.insertAdjacentHTML('beforeend', row);", 'insertAdjacentHTML() called with non-literal'],
      ['document.write(x);', 'document.write() called with non-literal'],
      ['document.writeln(`<p>${x}</p>`);', 'document.writeln() called with non-literal'],
      ['el.setHTMLUnsafe(x);', 'setHTMLUnsafe() called with non-literal'],
    ];
    for (const [src, frag] of bad) {
      const v = innerHtmlViolations('overlays.ts', src);
      expect(v.length, src).toBeGreaterThan(0);
      expect(v.join('\n'), src).toContain(frag);
    }
  });

  it('innerHTML: literal markup, textContent and unrelated write() calls are fine', () => {
    const good = [
      "el.innerHTML = '';",
      'el.innerHTML = `<hr>`;',
      "el.insertAdjacentHTML('beforeend', '<br>');",
      'el.textContent = data; el.setAttribute("title", data);',
      'const x = el.innerHTML;',
      'stream.write(chunk); sink.writeln(line);',
    ];
    for (const src of good) expect(innerHtmlViolations('overlays.ts', src), src).toEqual([]);
  });

  it('network: POST and other write methods, computed methods, XHR and beacons', () => {
    const bad: Array<[string, string]> = [
      ["fetch('/x', { method: 'POST' });", "'POST' request method"],
      ["fetch('/x', { method: 'post', body });", "'post' request method"],
      ["fetch('/x', { method: 'DELETE' });", "'DELETE' request method"],
      ["fetch('/x', { method: 'PUT' });", "'PUT' request method"],
      ["fetch('/x', { method: 'PATCH' });", "'PATCH' request method"],
      ["fetch('/x', { 'method': 'HEAD' });", "method 'HEAD'"],
      ["fetch('/x', { method: 'OPTIONS' });", "method 'OPTIONS'"],
      ["fetch('/x', { method: verb });", 'method is not a string literal'],
      ["fetch('/x', { method });", 'method is not a string literal (shorthand)'],
      ["fetch('/x', { method: `${v}` });", 'method is not a string literal'],
      ["const m = 'POST';", "'POST' request method"],
      ["const x = new XMLHttpRequest(); x.open('GET', '/x');", 'XMLHttpRequest'],
      ["navigator.sendBeacon('/x', body);", 'sendBeacon'],
      ["interface Init { method: 'POST' }", "'POST' request method"],
    ];
    for (const [src, frag] of bad) {
      const v = networkViolations('x.ts', src);
      expect(v.length, src).toBeGreaterThan(0);
      expect(v.join('\n'), src).toContain(frag);
    }
  });

  it('network: GET fetches, GET-typed inits and prose in comments are fine', () => {
    const good = [
      "fetch('/snapshot', { method: 'GET', headers });",
      "await f(url, { method: 'get', signal });",
      "interface Init { method: 'GET'; headers: Record<string, string> }",
      "// never POST: this is a read-only observer\nconst note = 'read-only, no posting';",
      'fetch(url);',
    ];
    for (const src of good) expect(networkViolations('x.ts', src), src).toEqual([]);
  });
});

// ---------- the real tree ----------

const files = walk(GARAGE);
const read = (f: string): string => readFileSync(join(GARAGE, f), 'utf8');
const codeFiles = files.filter((f) => CODE_EXTS.has(extname(f).toLowerCase()));
const fmt = (v: string[]): string => `\n${v.join('\n')}\n`;

describe('packages/garage tree', () => {
  it('lists the package (the lint is not vacuous)', () => {
    expect(files).toContain('package.json');
    for (const f of ['src/index.html', 'src/main.ts', 'src/overlays.ts', PALETTE, 'src/stream.ts']) expect(files, f).toContain(f);
    expect(codeFiles.length).toBeGreaterThan(5);
    expect(colourViolations(PALETTE, read(PALETTE)).length, 'the colour scan sees palette.ts colours').toBeGreaterThan(10);
  });

  it('has no image files', () => {
    expect(imageViolations(files), fmt(imageViolations(files))).toEqual([]);
  });

  it('has colour literals only in palette.ts, index.html included', () => {
    const v = files.filter((f) => f !== PALETTE).flatMap((f) => colourViolations(f, read(f)));
    expect(v, fmt(v)).toEqual([]);
  });

  it('has only relative .js imports, no node: imports, and @cockpit/* only as import type', () => {
    const v = codeFiles.flatMap((f) => importViolations(f, read(f)));
    expect(v, fmt(v)).toEqual([]);
  });

  it('never assigns non-literal data to innerHTML (overlays.ts and every other module)', () => {
    expect(codeFiles).toContain('src/overlays.ts');
    const v = codeFiles.flatMap((f) => innerHtmlViolations(f, read(f)));
    expect(v, fmt(v)).toEqual([]);
  });

  it('only ever issues GET requests, with no POST anywhere in src', () => {
    const v = codeFiles.flatMap((f) => networkViolations(f, read(f)));
    expect(v, fmt(v)).toEqual([]);
  });
});
