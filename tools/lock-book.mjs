#!/usr/bin/env node
// Locks the whole book behind one code, for the reader's copy at zencreation.org/read/.
//
// The book comes from the AgenticBook project's last whole-book export (npm run export there), which writes
// the book as data to AgenticBook/dist/book/build/book.json. This script turns that into book pages, encrypts
// them with the code (AES-256-GCM, key from PBKDF2-SHA256), and writes read/index.html, which is safe to publish:
// without the code it holds no readable text.
//
//   node tools/lock-book.mjs                         asks for the code
//   BOOK_CODE='your code' node tools/lock-book.mjs
//   BOOK_JSON=/path/to/book.json                     use another export
//
// Codes ignore capitals and surrounding spaces.
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { webcrypto as crypto } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = process.env.BOOK_JSON || path.resolve(root, '..', 'AgenticBook', 'dist', 'book', 'build', 'book.json');
const BOOK_DIR = path.resolve(path.dirname(SOURCE), '..', '..', '..', 'book');
const TEMPLATE = path.join(root, 'tools', 'reader-template.html');
const OUT = path.join(root, 'read', 'index.html');
const ITERATIONS = 600_000;
const PLACEHOLDER = '"__BOOK__"';

// ---- The pages ------------------------------------------------------------------

const x = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plain = (rs = []) => rs.map((r) => r.s).join('');
const clip = (s, n = 70) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')}…` : s);

// Inline runs from the export: {s, b?, i?, sup?}. A superscript links to its source at the foot of the page.
function inline(rs = [], no = 0, seen = new Set()) {
  return rs.map((r) => {
    if (r.sup) {
      return `<sup>${String(r.s).split(',').map((n) => {
        const id = `c${no}-${n}`, first = !seen.has(id);
        seen.add(id);
        return `<a href="#r${no}-${n}"${first ? ` id="${id}"` : ''} aria-label="Source ${x(n)}">${x(n)}</a>`;
      }).join(',')}</sup>`;
    }
    const t = x(r.s);
    return r.b ? `<strong>${t}</strong>` : r.i ? `<em>${t}</em>` : t;
  }).join('');
}

function blocks(bs = [], no = 0) {
  const seen = new Set();
  return bs.map((b) => (b.k === 'hr' ? '<hr>'
    : b.k === 'quote' ? `<blockquote><p>${inline(b.r, no, seen)}</p></blockquote>`
      : b.k === 'h2' || b.k === 'h1' ? `<h3>${inline(b.r, no, seen)}</h3>`
        : `<p>${inline(b.r, no, seen)}</p>`)).join('\n');
}

const PATH_SVG = `<svg class="path" viewBox="0 0 400 40" aria-hidden="true" focusable="false"><path class="line" d="M-4 28 C 60 31, 100 10, 170 16 S 280 34, 340 25 S 368 20, 378 22" /><circle class="pearl" cx="386" cy="22" r="6" /></svg>`;

function dayPage(d) {
  const ep = d.epigraph;
  const words = ep ? (ep.type === 'quote' ? `“${inline(ep.r, d.no)}”` : inline(ep.r, d.no)) : '';
  const credit = ep && ep.type !== 'italic'
    ? `<p class="by">${ep.type === 'paraphrase' ? '<i>adapted from</i> ' : ''}<span class="name">${x(ep.author)}</span></p>${ep.source ? `<p class="src">${x(ep.source)}</p>` : ''}`
    : '';
  const refs = [
    ...(d.epRefs?.length ? [`<li><span class="mark">Epigraph</span>${x(d.epRefs.join('; '))}</li>`] : []),
    ...(d.refs || []).map((r, i) => `<li id="r${d.no}-${i + 1}"><a class="mark" href="#c${d.no}-${i + 1}" aria-label="Back to the text">${i + 1}</a>${x(r)}</li>`),
  ];
  // What the Contents shows for this page (pages have no titles): the epigraph, and who said it.
  const hint = clip(ep ? plain(ep.r) : plain(d.reflection?.[0]?.r), 150);
  const by = ep && ep.type !== 'italic' ? ep.author.split(',')[0] : '';
  return `<article class="page" data-kind="page" data-no="${d.no}" data-section="${x(d.theme)}" data-hint="${x(hint)}" data-by="${x(by)}" aria-label="Page ${d.no}, ${x(d.theme)}">
<p class="label theme">${x(d.theme)}</p>
${ep ? `<div class="ep${ep.type === 'italic' ? ' own' : ''}"><p class="words">${words}</p>${credit}</div>` : ''}
<div class="body">${blocks(d.reflection, d.no)}</div>
${refs.length ? `<div class="refs"><p class="label">Sources</p><ol>${refs.join('')}</ol></div>` : ''}
<p class="folio">${d.no}</p>
</article>`;
}

const matterPage = (title, bs, cls = '') => `<article class="page matter${cls ? ` ${cls}` : ''}" data-kind="matter" data-title="${x(title)}" aria-label="${x(title)}">
${cls.includes('bare') ? '' : `<h2 class="matter-title">${x(title)}</h2>`}
<div class="body">${blocks(bs)}</div>
</article>`;

function render(book) {
  const out = [];
  out.push(`<article class="page cover-leaf" data-kind="cover" data-title="Cover" aria-label="Cover"><img src="../img/cover.jpg" width="900" height="1391" alt="The front cover of ${x(book.title)}, by ${x(book.byline)}."></article>`);
  out.push(`<article class="page title-leaf" data-kind="matter" data-title="Title page" aria-label="Title page">
<div class="title-block"><h2 class="book-title">${x(book.title)}</h2>${book.subtitle ? `<p class="book-sub">${x(book.subtitle)}</p>` : ''}<p class="book-by">${x(book.byline)}</p></div>
${PATH_SVG}
<div class="copyright">${book.publisher ? `<p class="label">${x(book.publisher)}</p>` : ''}${(book.copyright || []).map((p) => `<p>${x(p)}</p>`).join('')}</div>
</article>`);
  for (const f of book.front || []) out.push(matterPage(f.title, f.blocks, f.bare ? 'bare' : ''));
  const named = (book.sections || []).filter((s) => s.name);
  for (const s of book.sections || []) {
    if (s.name) {
      const first = s.days[0]?.no, last = s.days.at(-1)?.no;
      const range = first === last ? `${first}` : `${first}–${last}`;
      out.push(`<article class="page opener" data-kind="section" data-title="${x(s.name)}" data-range="${range}" aria-label="Section: ${x(s.name)}">
<p class="label">Section ${named.indexOf(s) + 1} of ${named.length}</p><h2>${x(s.name)}</h2><p class="range">Pages ${range}</p>${PATH_SVG}
</article>`);
    }
    for (const d of s.days) out.push(dayPage(d));
  }
  for (const f of book.back || []) out.push(matterPage(f.title, f.blocks));
  if (book.appendix?.length) out.push(matterPage('Original Wording', book.appendix, 'appendix'));
  for (const f of book.end || []) out.push(matterPage(f.title, f.blocks));
  return out.join('\n');
}

// ---- Freshness: warn when the book changed after its last export -----------------

async function newerThan(dir, since, skip = new Set(['feedback', 'research', 'cut', 'special-requests'])) {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!skip.has(e.name)) n += await newerThan(p, since, skip); }
    else if (/\.(md|json)$/.test(e.name) && (await stat(p)).mtimeMs > since) n++;
  }
  return n;
}

// ---- Lock -------------------------------------------------------------------------

// Must match normalize() in the reader template.
const normalize = (code) => code.normalize('NFC').trim().toLowerCase();
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

async function askCode() {
  if (process.env.BOOK_CODE) return process.env.BOOK_CODE;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = await rl.question('Code for the book: ');
  rl.close();
  return code;
}

let book;
try { book = JSON.parse(await readFile(SOURCE, 'utf8')); } catch {
  throw new Error(`No book export found at ${SOURCE}\nRun "npm run export" in the AgenticBook project first.`);
}
const exported = (await stat(SOURCE)).mtimeMs;
const changed = await newerThan(BOOK_DIR, exported);
if (changed) console.warn(`Warning: ${changed} book file${changed === 1 ? '' : 's'} changed after the last export. Run "npm run export" in AgenticBook for the latest pages.`);

const html = render(book);
const pages = (book.sections || []).reduce((n, s) => n + s.days.length, 0);
if (!pages) throw new Error(`The export at ${SOURCE} has no pages.`);

const template = await readFile(TEMPLATE, 'utf8');
if (template.split(PLACEHOLDER).length !== 2) throw new Error(`${TEMPLATE} must contain ${PLACEHOLDER} exactly once`);

const code = normalize(await askCode());
if (!code) throw new Error('The code is empty.');
if (code.length < 12) console.warn(`Warning: a ${code.length}-character code can be guessed. A phrase of 4+ words is much safer.`);

const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey(
  { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
  base, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
);
const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(html));

const payload = JSON.stringify({ v: 1, iter: ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(new Uint8Array(data)) });
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, template.replace(PLACEHOLDER, payload));
const sections = (book.sections || []).filter((s) => s.name).length;
console.log(`Locked the book (exported ${book.today}): ${pages} pages in ${sections} sections, plus front and back matter → ${path.relative(root, OUT)}`);
