function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

export function exportCsv(rows, columns, filename) {
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = columns.map((c) => escape(c.label)).join(',');
  const body = rows.map((row) => columns.map((c) => escape(c.value(row))).join(',')).join('\n');
  download(filename, `\ufeff${header}\n${body}\n`, 'text/csv;charset=utf-8');
}

export function exportJson(data, filename) {
  download(filename, `${JSON.stringify(data, null, 2)}\n`, 'application/json;charset=utf-8');
}
