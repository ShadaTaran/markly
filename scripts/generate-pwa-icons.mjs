#!/usr/bin/env node
// Stage 38 — deterministically derives the PWA manifest icon set from
// Markly's existing brand mark (the same rounded-square + bookmark glyph
// already used for src/app/icon.svg and public/notification-icon.svg), via
// Next's own bundled `next/og` ImageResponse renderer (Satori + resvg) — no
// new dependency, no external image tool, no hand-drawn PNGs.
//
// Run with: node scripts/generate-pwa-icons.mjs
// Re-run this whenever the brand mark's own path/colors change; the output
// files are checked in (a web app manifest needs stable, immediately
// fetchable static files, not an on-demand render route).

import { mkdirSync, writeFileSync } from "node:fs";

const BRAND_BLUE = "#3b82f6";
const GLYPH_WHITE = "#ffffff";
// Reproduced verbatim from src/app/icon.svg / public/notification-icon.svg —
// keep in sync if the brand mark ever changes.
const BOOKMARK_PATH = "M7 2a2 2 0 0 0-2 2v17a1 1 0 0 0 1.55.83L12 17.9l5.45 3.93A1 1 0 0 0 19 21V4a2 2 0 0 0-2-2H7z";

function h(type, props, ...children) {
  return { type, props: { ...props, children: children.length <= 1 ? children[0] : children } };
}

function glyph() {
  return h("path", { transform: "translate(4 4)", fill: GLYPH_WHITE, d: BOOKMARK_PATH });
}

/** The "any"-purpose icon: same rounded-square composition as the app's own favicon/notification icon, just rasterized at a larger PWA-required size. */
function anyPurposeIconTree(size) {
  return h(
    "div",
    { style: { width: "100%", height: "100%", display: "flex" } },
    h(
      "svg",
      { width: size, height: size, viewBox: "0 0 32 32", xmlns: "http://www.w3.org/2000/svg" },
      h("rect", { width: 32, height: 32, rx: 7, fill: BRAND_BLUE }),
      glyph(),
    ),
  );
}

/**
 * The "maskable"-purpose icon: Android launchers crop this to their own
 * mask shape (circle, squircle, rounded-square, teardrop, ...), so per the
 * maskable-icon spec (https://web.dev/articles/maskable-icon) two things
 * must hold: (1) the background fills the FULL edge-to-edge canvas — no
 * rounded corners baked in, since the OS supplies its own crop shape, and
 * any transparent/differently-colored corner would show through as a
 * mismatched ring under an aggressive mask; (2) all meaningful content
 * (the glyph) stays inside the centered "safe zone" — nominally an
 * 80%-diameter circle. The glyph is scaled to 85% about the canvas center,
 * which keeps its farthest corner comfortably inside that safe zone with
 * real margin to spare (not just barely passing), verified visually.
 */
function maskableIconTree(size) {
  return h(
    "div",
    { style: { width: "100%", height: "100%", display: "flex" } },
    h(
      "svg",
      { width: size, height: size, viewBox: "0 0 32 32", xmlns: "http://www.w3.org/2000/svg" },
      h("rect", { width: 32, height: 32, fill: BRAND_BLUE }),
      h("g", { transform: "translate(16 16) scale(0.85) translate(-16 -16)" }, glyph()),
    ),
  );
}

async function renderPng(tree, size) {
  const { ImageResponse } = await import("next/og.js");
  const response = new ImageResponse(tree, { width: size, height: size });
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  mkdirSync("public/icons", { recursive: true });

  const outputs = [
    { path: "public/icons/icon-192.png", tree: anyPurposeIconTree(192), size: 192 },
    { path: "public/icons/icon-512.png", tree: anyPurposeIconTree(512), size: 512 },
    { path: "public/icons/icon-maskable-512.png", tree: maskableIconTree(512), size: 512 },
  ];

  for (const { path, tree, size } of outputs) {
    const buffer = await renderPng(tree, size);
    writeFileSync(path, buffer);
    console.log(`wrote ${path} (${buffer.length} bytes, ${size}x${size})`);
  }
}

main().catch((err) => {
  console.error("ICON GENERATION FAILED:", err);
  process.exitCode = 1;
});
