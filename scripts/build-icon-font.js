#!/usr/bin/env node
/**
 * Build the status-bar icon font from icons/statusbar-glyph.svg.
 *
 * Produces icons/agent-quickpick.woff — a single-glyph font registered in
 * package.json under `contributes.icons` as `agent-quickpick` and referenced
 * from the status bar as `$(agent-quickpick)`.
 *
 * Icon fonts are monochrome: VS Code renders the glyph in the status-bar
 * foreground color. That's why the glyph is a plain single-path silhouette
 * (the 2x2 agent grid), not the colored extension logo.
 *
 * Run:  node scripts/build-icon-font.js
 * (Regenerate whenever icons/statusbar-glyph.svg changes.)
 */
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { SVGIcons2SVGFontStream } = require("svgicons2svgfont");
const svg2ttf = require("svg2ttf");
const ttf2woff = require("ttf2woff");

const ICONS_DIR = path.join(__dirname, "..", "icons");
const GLYPH_SVG = path.join(ICONS_DIR, "statusbar-glyph.svg");
const OUT_WOFF = path.join(ICONS_DIR, "agent-quickpick.woff");

// The codepoint referenced by fontCharacter in package.json (\\E900).
const CODEPOINT = 0xe900;

function buildSvgFont() {
  return new Promise((resolve, reject) => {
    let out = "";
    const fontStream = new SVGIcons2SVGFontStream({
      fontName: "agent-quickpick",
      fontHeight: 1000,
      normalize: true,
      log: () => {},
    });
    fontStream
      .on("data", (c) => (out += c.toString()))
      .on("end", () => resolve(out))
      .on("error", reject);

    const glyph = Readable.from([fs.readFileSync(GLYPH_SVG)]);
    glyph.metadata = { unicode: [String.fromCodePoint(CODEPOINT)], name: "agent" };
    fontStream.write(glyph);
    fontStream.end();
  });
}

(async () => {
  const svgFont = await buildSvgFont();
  const ttf = svg2ttf(svgFont, {});
  const woff = ttf2woff(Buffer.from(ttf.buffer));
  fs.writeFileSync(OUT_WOFF, Buffer.from(woff.buffer));
  console.log(`Wrote ${path.relative(process.cwd(), OUT_WOFF)} (codepoint U+${CODEPOINT.toString(16).toUpperCase()})`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
