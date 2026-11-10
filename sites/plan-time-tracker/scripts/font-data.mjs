import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fonts = [
  ['Host Grotesk', 'host-grotesk'],
  ['Atkinson Hyperlegible Mono', 'atkinson-hyperlegible-mono'],
];
const ranges = {
  'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF',
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
};
let css = '';
for (const [family, file] of fonts) {
  for (const [subset, range] of Object.entries(ranges)) {
    const data = (await readFile(resolve(root, `assets/fonts/${file}-${subset}.woff2`))).toString('base64');
    css += `@font-face{font-family:"${family}";font-style:normal;font-weight:400 500;font-display:swap;src:url(data:font/woff2;base64,${data}) format("woff2");unicode-range:${range}}\n`;
  }
}
const generated = '// Generated from assets/fonts by scripts/font-data.mjs. Do not edit.\nexport const UI_FONT_CSS = ' + JSON.stringify(css) + ';\n';
const sourcePath = resolve(root, 'worker/fonts.js');
if (process.argv.includes('--write')) {
  await writeFile(sourcePath, generated);
} else {
  if (await readFile(sourcePath, 'utf8') !== generated) throw new Error('worker/fonts.js is out of date; run node scripts/font-data.mjs --write');
  const source = await readFile(resolve(root, 'worker/index.js'), 'utf8');
  const importLine = 'import { UI_FONT_CSS } from "./fonts.js";';
  if (!source.includes(importLine)) throw new Error('Font import missing from Worker');
  await writeFile(resolve(root, 'dist/server/index.js'), source.replace(importLine, generated.replace('export const', 'const')));
}
