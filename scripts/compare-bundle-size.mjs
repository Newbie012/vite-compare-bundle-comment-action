#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      args[key.slice(2)] = true;
      continue;
    }
    args[key.slice(2)] = value;
    i += 1;
  }
  return args;
}

function readJsonArray(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const json = JSON.parse(raw);
  if (!Array.isArray(json)) {
    throw new Error(`Expected array JSON in ${filePath}`);
  }
  return json;
}

function formatBytes(bytes) {
  const abs = Math.abs(bytes);
  if (abs < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = abs / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }

  const signed = bytes < 0 ? -value : value;
  return `${signed.toFixed(2).replace(/\.00$/, "")} ${unit}`;
}

function formatDelta(bytes) {
  if (bytes === 0) {
    return "0 B";
  }
  return `${bytes > 0 ? "+" : ""}${formatBytes(bytes)}`;
}

function formatPercent(base, next) {
  if (base === 0 && next === 0) {
    return "0.00%";
  }
  if (base === 0) {
    return "new";
  }
  const delta = ((next - base) / base) * 100;
  return `${delta > 0 ? "+" : ""}${delta.toFixed(2)}%`;
}

function normalizeAssetName(name) {
  return name.replace(/-[A-Za-z0-9_-]{8,}(?=\.[^.]+$)/, "-[hash]");
}

function toAssetRow(row) {
  return {
    name: row.filename ?? row.label ?? "unknown",
    parsedSize: row.parsedSize ?? 0,
    gzipSize: row.gzipSize ?? 0,
  };
}

function totals(rows) {
  return rows.reduce(
    (acc, row) => ({
      parsed: acc.parsed + row.parsedSize,
      gzip: acc.gzip + row.gzipSize,
    }),
    { parsed: 0, gzip: 0 },
  );
}

function buildComparison(baseRows, currentRows) {
  const groups = new Map();

  for (const row of baseRows) {
    const key = normalizeAssetName(row.name);
    const entry = groups.get(key) ?? { key, base: [], current: [] };
    entry.base.push(row);
    groups.set(key, entry);
  }

  for (const row of currentRows) {
    const key = normalizeAssetName(row.name);
    const entry = groups.get(key) ?? { key, base: [], current: [] };
    entry.current.push(row);
    groups.set(key, entry);
  }

  const bigger = [];
  const smaller = [];
  const added = [];
  const removed = [];

  for (const group of groups.values()) {
    const base = [...group.base].sort((a, b) => a.parsedSize - b.parsedSize);
    const current = [...group.current].sort(
      (a, b) => a.parsedSize - b.parsedSize,
    );
    const pairCount = Math.min(base.length, current.length);

    for (let i = 0; i < pairCount; i += 1) {
      const previous = base[i];
      const next = current[i];
      const parsedDelta = next.parsedSize - previous.parsedSize;
      const gzipDelta = next.gzipSize - previous.gzipSize;

      if (parsedDelta > 0) {
        bigger.push({ key: group.key, previous, next, parsedDelta, gzipDelta });
      } else if (parsedDelta < 0) {
        smaller.push({
          key: group.key,
          previous,
          next,
          parsedDelta,
          gzipDelta,
        });
      }
    }

    if (current.length > base.length) {
      for (const item of current.slice(base.length)) {
        added.push({ key: group.key, next: item });
      }
    }

    if (base.length > current.length) {
      for (const item of base.slice(current.length)) {
        removed.push({ key: group.key, previous: item });
      }
    }
  }

  bigger.sort((a, b) => b.parsedDelta - a.parsedDelta);
  smaller.sort((a, b) => a.parsedDelta - b.parsedDelta);
  added.sort((a, b) => b.next.parsedSize - a.next.parsedSize);
  removed.sort((a, b) => b.previous.parsedSize - a.previous.parsedSize);

  return { bigger, smaller, added, removed };
}

function formatPair(before, after) {
  return `${formatBytes(before)} -> ${formatBytes(after)} (${formatDelta(after - before)})`;
}

function asRows(items, type) {
  if (type === "added") {
    return items.map((item) => ({
      asset: item.next.name,
      size: `${formatPair(0, item.next.parsedSize)}<br />${formatPair(0, item.next.gzipSize)} (gzip)`,
      changed: "new",
    }));
  }

  if (type === "removed") {
    return items.map((item) => ({
      asset: item.previous.name,
      size: `${formatPair(item.previous.parsedSize, 0)}<br />${formatPair(item.previous.gzipSize, 0)} (gzip)`,
      changed: "-100.00%",
    }));
  }

  return items.map((item) => ({
    asset: item.key,
    size: `${formatPair(item.previous.parsedSize, item.next.parsedSize)}<br />${formatPair(item.previous.gzipSize, item.next.gzipSize)} (gzip)`,
    changed: formatPercent(item.previous.parsedSize, item.next.parsedSize),
  }));
}

function table(rows, limit = 20) {
  if (rows.length === 0) {
    return "No files were changed";
  }
  const shown = rows.slice(0, limit);
  const lines = shown.map(
    (row) => `| ${row.asset} | ${row.size} | ${row.changed} |`,
  );
  return [
    "| Asset | File Size | % Changed |",
    "| ----- | --------- | --------- |",
    ...lines,
  ].join("\n");
}

function renderComment({ baseRows, currentRows, title, comparison }) {
  const marker = `<!-- bundle-size-compare-action key:${title} -->`;
  const baseTotal = totals(baseRows);
  const currentTotal = totals(currentRows);

  const biggerRows = asRows(comparison.bigger, "bigger");
  const smallerRows = asRows(comparison.smaller, "smaller");
  const addedRows = asRows(comparison.added, "added");
  const removedRows = asRows(comparison.removed, "removed");
  const changeRows = [
    ...addedRows,
    ...removedRows,
    ...biggerRows,
    ...smallerRows,
  ];

  return `
### Bundle Stats - ${title}

This comment is generated automatically from Vite stats JSON files.

**Total**

Files count | Total bundle size | % Changed
----------- | ----------------- | ---------
${currentRows.length} | ${formatPair(baseTotal.parsed, currentTotal.parsed)}<br />${formatPair(baseTotal.gzip, currentTotal.gzip)} (gzip) | ${formatPercent(baseTotal.parsed, currentTotal.parsed)}

Changeset

${table(changeRows)}

<details>
<summary>View detailed bundle breakdown</summary>

**Added**

${table(addedRows, 50)}

**Removed**

${table(removedRows, 50)}

**Bigger**

${table(biggerRows, 50)}

**Smaller**

${table(smallerRows, 50)}

</details>

${marker}
`.trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const basePath = args.base;
  const currentPath = args.current;
  const outputPath = args.output;
  const title = args.title || "Vite Bundle Size Comparison";

  if (!basePath || !currentPath || !outputPath) {
    throw new Error(
      "Usage: compare-bundle-size.mjs --base <file> --current <file> --output <file> [--title <text>]",
    );
  }

  const baseRows = readJsonArray(basePath).map(toAssetRow);
  const currentRows = readJsonArray(currentPath).map(toAssetRow);
  const comparison = buildComparison(baseRows, currentRows);
  const body = renderComment({ baseRows, currentRows, title, comparison });

  fs.writeFileSync(path.resolve(outputPath), `${body}\n`, "utf8");
}

main();
