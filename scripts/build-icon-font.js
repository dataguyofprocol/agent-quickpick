#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { SVGIcons2SVGFontStream } = require("svgicons2svgfont");
const svg2ttf = require("svg2ttf");
const ttf2woff = require("ttf2woff");

const ICONS_DIR = path.join(__dirname, "..", "icons");
const GLYPH_SVG = path.join(ICONS_DIR, "statusbar-glyph.svg");
const OUT_WOFF = path.join(ICONS_DIR, "agent-quickpick.woff");

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
