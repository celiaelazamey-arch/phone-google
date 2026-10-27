/**
 * Small RFC 4180 CSV reader/writer — no dependency, strict about structure so a
 * malformed registry fails loudly instead of importing half a column.
 */

export function parseCsv(text, { delimiter = ',', maxRows = 50_000 } = {}) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push({ line: rowLine, cells: row });
    row = [];
    rowLine = line;
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }
    if (char === '"') {
      if (field.trim() !== '') throw new Error(`csv: stray quote on line ${line}`);
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      pushField();
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      line += 1;
      pushRow();
      if (rows.length > maxRows) throw new Error(`csv: more than ${maxRows} rows`);
      continue;
    }
    field += char;
  }
  if (inQuotes) throw new Error(`csv: unterminated quoted field near line ${line}`);
  if (field !== '' || row.length) pushRow();

  if (!rows.length) throw new Error('csv: empty file');
  const header = rows[0].cells.map((cell) => cell.trim());
  const seen = new Set();
  for (const name of header) {
    if (!name) throw new Error('csv: empty header name');
    if (seen.has(name)) throw new Error(`csv: duplicate column ${name}`);
    seen.add(name);
  }
  const records = rows.slice(1).filter((entry) => entry.cells.some((cell) => cell.trim() !== ''));
  return {
    header,
    records: records.map((entry) => {
      const values = {};
      header.forEach((name, index) => {
        values[name] = (entry.cells[index] ?? '').trim();
      });
      return { line: entry.line, values };
    })
  };
}

export function toCsv(header, rows) {
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [header.map(escape).join(',')];
  for (const row of rows) lines.push(header.map((name) => escape(row[name])).join(','));
  return `${lines.join('\n')}\n`;
}
