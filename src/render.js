import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';

const TEMPLATE = join(ROOT, 'templates', 'dashboard.html');
const OUT_DIR = join(ROOT, 'dist');

/**
 * Inject the aggregated data into the dashboard template and write a fully
 * self-contained HTML file (no server / network needed to view it).
 * @param {object} data result of aggregate() (or publicize())
 * @param {{ outFile?: string }} [opts] output filename within dist/ (default index.html)
 * @returns {string} the output file path
 */
export function render(data, { outFile = 'index.html' } = {}) {
  const tpl = readFileSync(TEMPLATE, 'utf8');
  // JSON is valid JS; escape `<` so an embedded "</script>" can't break out.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const html = tpl.replace('/*__DATA__*/ null', json);

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, outFile);
  writeFileSync(path, html);
  return path;
}
