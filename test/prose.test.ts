import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { Prose } from '@/components/ui/Prose';

const render = (text: string) => renderToStaticMarkup(createElement(Prose, { text }));

describe('Prose tables', () => {
  const TABLE = [
    '| Vault | Net APY | Curator |',
    '|---|---|---|',
    '| Steakhouse Ethena USDtb | 14.22% | Steakhouse Financial |',
    '| Clearstar USDC Reactor | 10.41% | Clearstar |',
  ].join('\n');

  it('renders a markdown table as a real table, not as raw pipes', () => {
    // Left unparsed, this collapsed into one unreadable paragraph of pipes.
    const html = render(TABLE);

    assert.ok(html.includes('<table'), 'should produce a table element');
    assert.ok(html.includes('<th'), 'should produce header cells');
    assert.ok(!html.includes('|---|'), 'separator syntax must not leak through');
    assert.ok(!html.includes('| Vault |'), 'raw pipe syntax must not leak through');
  });

  it('keeps every header and row', () => {
    const html = render(TABLE);
    for (const value of ['Vault', 'Net APY', 'Curator', 'Steakhouse Ethena USDtb', '10.41%', 'Clearstar']) {
      assert.ok(html.includes(value), `missing "${value}"`);
    }
    assert.equal((html.match(/<tr/g) ?? []).length, 3, 'one header row plus two body rows');
  });

  it('right-aligns numeric columns so magnitudes compare down the column', () => {
    const html = render(TABLE);
    // The APY column is numeric; the vault and curator columns are not.
    assert.ok(html.includes('is-num'), 'numeric column should be marked');
    assert.equal((html.match(/is-num/g) ?? []).length, 3, 'one header plus two cells');
  });

  it('pads a ragged row instead of rendering a broken table', () => {
    const html = render(['| A | B | C |', '|---|---|---|', '| only-one |'].join('\n'));
    assert.equal((html.match(/<td/g) ?? []).length, 3);
  });

  it('does not mistake a sentence containing a pipe for a table', () => {
    const html = render('Use the a | b syntax when filtering.');
    assert.ok(!html.includes('<table'));
    assert.ok(html.includes('Use the a | b syntax'));
  });

  it('requires the separator row, not just pipes', () => {
    const html = render(['| A | B |', '| 1 | 2 |'].join('\n'));
    assert.ok(!html.includes('<table'), 'without a separator this is not a table');
  });

  it('renders prose before and after a table', () => {
    const html = render(`Here are the options.\n\n${TABLE}\n\nPick based on risk.`);
    assert.ok(html.includes('Here are the options.'));
    assert.ok(html.includes('<table'));
    assert.ok(html.includes('Pick based on risk.'));
  });

  it('applies inline formatting inside cells', () => {
    const html = render(['| Name | Note |', '|---|---|', '| **Bold** | `code` |'].join('\n'));
    assert.ok(html.includes('<strong>Bold</strong>'));
    assert.ok(html.includes('<code'));
  });

  it('escapes HTML in cells rather than injecting it', () => {
    // Model output is untrusted; a table cell must not become markup.
    const html = render(['| X |', '|---|', '| <img src=x onerror=alert(1)> |'].join('\n'));
    assert.ok(!html.includes('<img'), 'raw HTML must never reach the DOM');
    assert.ok(html.includes('&lt;img'));
  });
});

describe('Prose basics still work alongside tables', () => {
  it('renders headings, lists and paragraphs', () => {
    const html = render('## Options\n\n- first\n- second\n\nPlain text.');
    assert.ok(html.includes('<h3'));
    assert.ok((html.match(/<li/g) ?? []).length === 2);
    assert.ok(html.includes('Plain text.'));
  });
});
