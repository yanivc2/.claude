// The scan review screen's line editor is a WIDE table on a desktop and a stacked labelled card
// per line on a phone — `.line-grid` in nocturne.css hides the <thead> under 760px and prints each
// cell's `data-label` above its control instead. That trick has one fragile dependency: EVERY data
// cell must carry `data-label`. Add a column without one and that field silently loses its label
// on every phone — the screen still "works", so nothing else would catch it.
//
// (The cash-expenses rubric solved the same problem with a different technique, .cx-list; see
// test/cash-expense-layout.test.js. Both are legitimate — what matters is that each stays intact.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const view = readFileSync(path.join(root, 'src', 'views', 'scan', 'show.ejs'), 'utf8');
const css = readFileSync(path.join(root, 'src', 'public', 'nocturne.css'), 'utf8');

test('the phone layout for the scan line editor is still defined', () => {
  const media = css.slice(css.indexOf('@media (max-width: 760px)', css.indexOf('.line-grid')));
  assert.ok(media.includes('.line-grid thead'), 'the header row is hidden on a phone');
  assert.ok(media.includes('content: attr(data-label)'), 'each cell prints its own label instead');
});

test('every line-editor cell that holds a control carries its data-label', () => {
  // The server-rendered rows…
  const body = view.slice(view.indexOf('<tbody id="linesBody">'), view.indexOf('</tbody>', view.indexOf('<tbody id="linesBody">')));
  // …and the row the "הוסף שורה +" button builds, which must match it.
  const added = view.slice(view.indexOf("var tr = document.createElement('tr');"), view.indexOf('body.appendChild(tr)'));

  for (const [where, html] of [['server-rendered row', body], ['added row', added]]) {
    const cells = [...html.matchAll(/<td([^>]*)>([\s\S]*?)(?=<td|<\/tr)/g)];
    assert.ok(cells.length >= 8, `${where}: expected the full set of columns, got ${cells.length}`);
    for (const [, attrs, inner] of cells) {
      const holdsControl = /<(input|select)\b/.test(inner) || /class="pack-cost"/.test(inner);
      if (!holdsControl) continue; // the delete-button cell needs no label
      assert.match(attrs, /data-label=/, `${where}: a cell with a field has no data-label → ${attrs.trim()}`);
    }
  }
});
