# Fonts

Host Grotesk and Atkinson Hyperlegible Mono were obtained from Google Fonts as
WOFF2 Latin and Latin Extended subsets. Each is distributed under its adjacent
SIL Open Font License 1.1 file. The subsets do not contain Cyrillic; unsupported
characters use the system font in the CSS fallback stack.

After updating these files, regenerate the source module with
`node scripts/font-data.mjs --write`. The build checks that module against the
font files and embeds it in the single-file Worker artifact, so the browser
loads the fonts without contacting an external service.
