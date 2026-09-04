import { Fragment, type ReactNode } from 'react';
import './prose.css';

/**
 * Renders the slice of Markdown the model actually produces — headings,
 * bullets, numbered lists, tables, bold, and inline code — as React elements.
 *
 * Deliberately not a Markdown library and deliberately never
 * `dangerouslySetInnerHTML`: model output is untrusted text, and building
 * elements directly makes HTML injection structurally impossible.
 */
export function Prose({ text }: { text: string }) {
  return <div className="prose">{renderBlocks(text)}</div>;
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(<p key={`p${blocks.length}`}>{renderInline(paragraph.join(' '))}</p>);
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item, i) => <li key={i}>{renderInline(item)}</li>);
    blocks.push(
      list.ordered
        ? <ol key={`l${blocks.length}`}>{items}</ol>
        : <ul key={`l${blocks.length}`}>{items}</ul>,
    );
    list = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    if (trimmed === '') {
      flushParagraph();
      flushList();
      continue;
    }

    // Tables need a two-line lookahead, so they are matched before anything else.
    const table = parseTable(lines, index);
    if (table) {
      flushParagraph();
      flushList();
      blocks.push(<MarkdownTable key={`t${blocks.length}`} {...table.data} />);
      index = table.nextIndex - 1;
      continue;
    }

    const heading = /^#{1,4}\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push(<h3 key={`h${blocks.length}`}>{renderInline(heading[1] ?? '')}</h3>);
      continue;
    }

    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] }; }
      list.items.push(bullet[1] ?? '');
      continue;
    }

    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (numbered) {
      flushParagraph();
      if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] }; }
      list.items.push(numbered[1] ?? '');
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  return blocks;
}

interface TableData {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** Columns whose values are numeric, so they can be right-aligned. */
  readonly numericColumns: ReadonlySet<number>;
}

/**
 * A Markdown table is a header row, a `|---|---|` separator, then body rows.
 * The separator is what distinguishes a real table from a paragraph that
 * happens to contain a pipe, so it is required rather than inferred.
 */
function parseTable(lines: readonly string[], start: number): { data: TableData; nextIndex: number } | null {
  const headerLine = lines[start]?.trim() ?? '';
  const separator = lines[start + 1]?.trim() ?? '';

  if (!headerLine.includes('|')) return null;
  if (!/^\|?[\s:-]*-[-\s:|]*\|?$/.test(separator) || !separator.includes('-')) return null;

  const headers = splitRow(headerLine);
  if (headers.length === 0) return null;

  const rows: string[][] = [];
  let index = start + 2;
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? '';
    if (line === '' || !line.includes('|')) break;

    const cells = splitRow(line);
    // Pad or trim so every row matches the header, rather than rendering a
    // ragged table when the model miscounts its own columns.
    rows.push(
      Array.from({ length: headers.length }, (_, column) => cells[column] ?? ''),
    );
    index += 1;
  }

  if (rows.length === 0) return null;

  const numericColumns = new Set<number>();
  for (let column = 0; column < headers.length; column += 1) {
    const values = rows.map((row) => row[column] ?? '').filter((v) => v !== '');
    if (values.length > 0 && values.every(isNumericCell)) numericColumns.add(column);
  }

  return { data: { headers, rows, numericColumns }, nextIndex: index };
}

/** Splits a row on pipes, dropping the empty edges from leading/trailing bars. */
function splitRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** Percentages, currency, and plain numbers all read better right-aligned. */
function isNumericCell(value: string): boolean {
  return /^[$€£]?\s*[<>~≈]?\s*-?[\d,.]+\s*[%kKmMbB]?\s*$/.test(value);
}

function MarkdownTable({ headers, rows, numericColumns }: TableData) {
  return (
    <div className="prose-table-scroll">
      <table className="prose-table">
        <thead>
          <tr>
            {headers.map((header, column) => (
              <th key={column} scope="col" className={numericColumns.has(column) ? 'is-num' : undefined}>
                {renderInline(header)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, column) => (
                <td key={column} className={numericColumns.has(column) ? 'is-num num' : undefined}>
                  {renderInline(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Splits on `**bold**` and `` `code` `` while leaving all other text literal. */
function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.filter(Boolean).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={index} className="num">{part.slice(1, -1)}</code>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}
