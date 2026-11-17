import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { deflateSync } from "node:zlib";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { checkPath, type JailConfig } from "./jail.ts";

export interface ChartToolsContext {
  channelLabel: string;
  jail: JailConfig;
  canUpload?: boolean;
}

type ChartType = "bar" | "line" | "scatter";

type RawDatum = {
  label?: string;
  x?: number | string;
  y?: number;
  value?: number;
};

type PreparedPoint = {
  label: string;
  x: number;
  y: number;
  displayX: string;
};

type Rgb = [number, number, number];

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 480;
const MAX_POINTS = 500;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function defaultChartPath(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `generated/chart-${stamp}.png`;
}

function ensurePngExtension(path: string): string {
  const ext = extname(path);
  return ext ? `${path.slice(0, -ext.length)}.png` : `${path}.png`;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }
  return value;
}

function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function prepareData(chartType: ChartType, raw: RawDatum[]): { points: PreparedPoint[]; categoricalX: boolean } {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("create_chart needs at least one data point.");
  if (raw.length > MAX_POINTS) throw new Error(`create_chart accepts at most ${MAX_POINTS} data points.`);

  if (chartType === "bar") {
    return {
      categoricalX: true,
      points: raw.map((d, i) => {
        const y = finiteNumber(d.value ?? d.y, `data[${i}].value`);
        const label = String(d.label ?? d.x ?? `Item ${i + 1}`);
        return { label, displayX: label, x: i, y };
      }),
    };
  }

  const allNumericX = raw.every((d) => typeof d.x === "number" && Number.isFinite(d.x));
  if (chartType === "scatter" && !allNumericX) {
    throw new Error("scatter charts need a finite numeric `x` for every data point.");
  }

  return {
    categoricalX: !allNumericX,
    points: raw.map((d, i) => {
      const y = finiteNumber(d.value ?? d.y, `data[${i}].y`);
      const x = allNumericX ? finiteNumber(d.x, `data[${i}].x`) : i;
      const displayX = String(d.label ?? d.x ?? i + 1);
      return { label: String(d.label ?? displayX), displayX, x, y };
    }),
  };
}

function extent(values: number[], padZero = false): [number, number] {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (padZero) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  if (min === max) {
    const pad = Math.abs(min || 1) * 0.1;
    min -= pad;
    max += pad;
  }
  return [min, max];
}

function scale(value: number, domain: [number, number], range: [number, number]): number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  return r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);
}

function sample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = (items.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => items[Math.round(i * step)]!);
}

const namedColors: Record<string, Rgb> = {
  black: [0, 0, 0],
  blue: [37, 99, 235],
  cyan: [6, 182, 212],
  gray: [100, 116, 139],
  green: [22, 163, 74],
  grey: [100, 116, 139],
  indigo: [79, 70, 229],
  orange: [249, 115, 22],
  pink: [236, 72, 153],
  purple: [147, 51, 234],
  red: [220, 38, 38],
  slate: [71, 85, 105],
  teal: [20, 184, 166],
  white: [255, 255, 255],
  yellow: [234, 179, 8],
};

function parseColor(value: string): Rgb {
  const trimmed = value.trim().toLowerCase();
  const named = namedColors[trimmed];
  if (named) return named;

  const shortHex = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (shortHex) {
    const hex = shortHex[1]!;
    return [0, 1, 2].map((i) => parseInt(hex[i]! + hex[i]!, 16)) as Rgb;
  }

  const longHex = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (longHex) {
    const hex = longHex[1]!;
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }

  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(trimmed);
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])].map((component) => Math.max(0, Math.min(255, component))) as Rgb;
  }

  throw new Error("color must be a hex color, rgb(r,g,b), or a supported color name.");
}

function lighten([r, g, b]: Rgb, amount: number): Rgb {
  return [r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount].map(Math.round) as Rgb;
}

const font: Record<string, string[]> = {
  " ": ["0", "0", "0", "0", "0", "0", "0"],
  "!": ["1", "1", "1", "1", "1", "0", "1"],
  "\"": ["101", "101", "101", "000", "000", "000", "000"],
  "#": ["01010", "11111", "01010", "11111", "01010", "00000", "00000"],
  "$": ["01110", "10100", "01110", "00101", "11110", "00100", "00000"],
  "%": ["11001", "11010", "00100", "01011", "10011", "00000", "00000"],
  "&": ["01100", "10010", "10100", "01000", "10101", "10010", "01101"],
  "'": ["1", "1", "1", "0", "0", "0", "0"],
  "(": ["01", "10", "10", "10", "10", "10", "01"],
  ")": ["10", "01", "01", "01", "01", "01", "10"],
  "*": ["000", "101", "010", "111", "010", "101", "000"],
  "+": ["000", "010", "010", "111", "010", "010", "000"],
  ",": ["0", "0", "0", "0", "0", "1", "1"],
  "-": ["000", "000", "000", "111", "000", "000", "000"],
  ".": ["0", "0", "0", "0", "0", "0", "1"],
  "/": ["00001", "00010", "00100", "01000", "10000", "00000", "00000"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  ":": ["0", "1", "0", "0", "0", "1", "0"],
  ";": ["0", "1", "0", "0", "0", "1", "1"],
  "<": ["0001", "0010", "0100", "1000", "0100", "0010", "0001"],
  "=": ["000", "000", "111", "000", "111", "000", "000"],
  ">": ["1000", "0100", "0010", "0001", "0010", "0100", "1000"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  "@": ["01110", "10001", "10111", "10101", "10111", "10000", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10011", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["111", "010", "010", "010", "010", "010", "111"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "[": ["11", "10", "10", "10", "10", "10", "11"],
  "\\": ["10000", "01000", "00100", "00010", "00001", "00000", "00000"],
  "]": ["11", "01", "01", "01", "01", "01", "11"],
  "_": ["000", "000", "000", "000", "000", "000", "111"],
};

function textWidth(text: string, size: number): number {
  return [...text.toUpperCase()].reduce((width, char) => {
    const glyph = font[char] ?? font[" "]!;
    return width + (Math.max(...glyph.map((row) => row.length)) + 1) * size;
  }, 0);
}

function truncateText(text: string, maxWidth: number, size: number): string {
  if (textWidth(text, size) <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && textWidth(`${truncated}...`, size) > maxWidth) truncated = truncated.slice(0, -1);
  return `${truncated}...`;
}

class Raster {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number, fill: Rgb) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 3);
    for (let i = 0; i < this.data.length; i += 3) {
      this.data[i] = fill[0];
      this.data[i + 1] = fill[1];
      this.data[i + 2] = fill[2];
    }
  }

  setPixel(x: number, y: number, color: Rgb): void {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || px >= this.width || py < 0 || py >= this.height) return;
    const offset = (py * this.width + px) * 3;
    this.data[offset] = color[0];
    this.data[offset + 1] = color[1];
    this.data[offset + 2] = color[2];
  }

  fillRect(x0: number, y0: number, x1: number, y1: number, color: Rgb): void {
    const left = Math.max(0, Math.min(this.width - 1, Math.round(Math.min(x0, x1))));
    const right = Math.max(0, Math.min(this.width - 1, Math.round(Math.max(x0, x1))));
    const top = Math.max(0, Math.min(this.height - 1, Math.round(Math.min(y0, y1))));
    const bottom = Math.max(0, Math.min(this.height - 1, Math.round(Math.max(y0, y1))));
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) this.setPixel(x, y, color);
    }
  }

  drawLine(x0: number, y0: number, x1: number, y1: number, color: Rgb, thickness = 1): void {
    let ix0 = Math.round(x0);
    let iy0 = Math.round(y0);
    const ix1 = Math.round(x1);
    const iy1 = Math.round(y1);
    const dx = Math.abs(ix1 - ix0);
    const sx = ix0 < ix1 ? 1 : -1;
    const dy = -Math.abs(iy1 - iy0);
    const sy = iy0 < iy1 ? 1 : -1;
    let err = dx + dy;
    const radius = Math.floor(thickness / 2);

    while (true) {
      this.fillRect(ix0 - radius, iy0 - radius, ix0 + radius, iy0 + radius, color);
      if (ix0 === ix1 && iy0 === iy1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        ix0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        iy0 += sy;
      }
    }
  }

  fillCircle(cx: number, cy: number, radius: number, color: Rgb): void {
    const centerX = Math.round(cx);
    const centerY = Math.round(cy);
    const r = Math.round(radius);
    for (let y = -r; y <= r; y += 1) {
      for (let x = -r; x <= r; x += 1) {
        if (x * x + y * y <= r * r) this.setPixel(centerX + x, centerY + y, color);
      }
    }
  }

  drawText(text: string, x: number, y: number, color: Rgb, size = 2): void {
    let cursor = Math.round(x);
    const top = Math.round(y);
    for (const rawChar of text.toUpperCase()) {
      const glyph = font[rawChar] ?? font[" "]!;
      for (let row = 0; row < glyph.length; row += 1) {
        const line = glyph[row]!;
        for (let col = 0; col < line.length; col += 1) {
          if (line[col] === "1") {
            this.fillRect(cursor + col * size, top + row * size, cursor + (col + 1) * size - 1, top + (row + 1) * size - 1, color);
          }
        }
      }
      cursor += (Math.max(...glyph.map((row) => row.length)) + 1) * size;
    }
  }
}

let crcTable: Uint32Array | undefined;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

function crc32(buffer: Buffer): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const rowLength = width * 3;
  const raw = Buffer.alloc((rowLength + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const sourceStart = y * rowLength;
    const destinationStart = y * (rowLength + 1);
    raw[destinationStart] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + sourceStart, rowLength).copy(raw, destinationStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

function renderChartPng(input: {
  chartType: ChartType;
  points: PreparedPoint[];
  categoricalX: boolean;
  title?: string;
  xLabel?: string;
  yLabel?: string;
  width: number;
  height: number;
  color: string;
}): Buffer {
  const { chartType, points, categoricalX, width, height } = input;
  const margin = { top: input.title ? 70 : 40, right: 36, bottom: input.xLabel ? 92 : 70, left: input.yLabel ? 92 : 68 };
  const plotLeft = margin.left;
  const plotTop = margin.top;
  const plotRight = width - margin.right;
  const plotBottom = height - margin.bottom;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;
  const yDomain = extent(points.map((p) => p.y), chartType === "bar");
  const xDomain = extent(points.map((p) => p.x));
  const y = (v: number) => scale(v, yDomain, [plotBottom, plotTop]);
  const x = (v: number) =>
    categoricalX && points.length === 1 ? plotLeft + plotWidth / 2 : scale(v, xDomain, [plotLeft, plotRight]);

  const tickCount = 5;
  const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => yDomain[0] + ((yDomain[1] - yDomain[0]) * i) / tickCount);
  const xTicks = categoricalX
    ? sample(points, Math.min(8, points.length)).map((p) => ({ value: p.x, label: p.displayX }))
    : Array.from({ length: tickCount + 1 }, (_, i) => xDomain[0] + ((xDomain[1] - xDomain[0]) * i) / tickCount).map((value) => ({ value, label: num(value) }));

  const axisColor: Rgb = [51, 65, 85];
  const gridColor: Rgb = [226, 232, 240];
  const textColor: Rgb = [15, 23, 42];
  const mutedColor: Rgb = [71, 85, 105];
  const markColor = parseColor(input.color || "#2563eb");
  const markHighlight = lighten(markColor, 0.16);
  const canvas = new Raster(width, height, [255, 255, 255]);

  if (input.title) {
    const titleSize = width < 480 ? 2 : 3;
    const title = truncateText(input.title, width - 48, titleSize);
    canvas.drawText(title, (width - textWidth(title, titleSize)) / 2, 28, textColor, titleSize);
  }

  for (const tick of yTicks) {
    const py = y(tick);
    canvas.drawLine(plotLeft, py, plotRight, py, gridColor);
    const label = num(tick);
    canvas.drawText(label, plotLeft - textWidth(label, 2) - 12, py - 7, mutedColor, 2);
  }
  canvas.drawLine(plotLeft, plotBottom, plotRight, plotBottom, axisColor, 2);
  canvas.drawLine(plotLeft, plotTop, plotLeft, plotBottom, axisColor, 2);

  for (const tick of xTicks) {
    const px = x(tick.value);
    canvas.drawLine(px, plotBottom, px, plotBottom + 5, axisColor);
    const label = truncateText(tick.label, Math.max(30, plotWidth / Math.max(xTicks.length, 1) - 6), 2);
    canvas.drawText(label, px - textWidth(label, 2) / 2, plotBottom + 18, mutedColor, 2);
  }

  if (input.xLabel) {
    const label = truncateText(input.xLabel, plotWidth, 2);
    canvas.drawText(label, plotLeft + (plotWidth - textWidth(label, 2)) / 2, height - 32, textColor, 2);
  }
  if (input.yLabel) {
    const label = truncateText(input.yLabel, plotWidth, 2);
    canvas.drawText(label, plotLeft, Math.max(8, plotTop - 28), textColor, 2);
  }

  if (chartType === "bar") {
    const gap = Math.min(16, (plotWidth / Math.max(points.length, 1)) * 0.25);
    const slot = plotWidth / Math.max(points.length, 1);
    const barWidth = Math.max(2, slot - gap);
    const base = y(Math.max(0, yDomain[0]));
    points.forEach((p, i) => {
      const left = plotLeft + i * slot + gap / 2;
      const top = Math.min(base, y(p.y));
      const bottom = Math.max(base, y(p.y));
      canvas.fillRect(left, top, left + barWidth, bottom, markColor);
      canvas.fillRect(left, top, left + barWidth, Math.min(bottom, top + 4), markHighlight);
    });
  } else {
    if (chartType === "line") {
      for (let i = 1; i < points.length; i += 1) {
        const previous = points[i - 1]!;
        const current = points[i]!;
        canvas.drawLine(x(previous.x), y(previous.y), x(current.x), y(current.y), markColor, 3);
      }
    }
    points.forEach((p) => canvas.fillCircle(x(p.x), y(p.y), 4, markColor));
  }

  return encodePng(width, height, canvas.data);
}

export function createChartTools(ctx: ChartToolsContext): ToolDefinition[] {
  const tool = defineTool({
    name: "create_chart",
    label: "Create a chart",
    description:
      "Create a deterministic PNG chart from structured data and write it to the channel workspace without using bash or an external image generator. " +
      "Use this for bar, line, and scatter charts. The result is a PNG file" +
      (ctx.canUpload ? "; use upload_file to share it in Slack, where it appears inline." : "."),
    parameters: Type.Object({
      chart_type: Type.Union([Type.Literal("bar"), Type.Literal("line"), Type.Literal("scatter")], {
        description: "Chart type to render.",
      }),
      data: Type.Array(
        Type.Object({
          label: Type.Optional(Type.String({ description: "Display label for this point or bar." })),
          x: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "X value. Scatter charts require a numeric x." })),
          y: Type.Optional(Type.Number({ description: "Y value for line/scatter charts, or bar height if value is omitted." })),
          value: Type.Optional(Type.Number({ description: "Bar height, or an alias for y." })),
        }),
        { description: "Chart data points. Bar charts use label/x plus value/y; line charts can use numeric or categorical x; scatter charts need numeric x and y." },
      ),
      output_path: Type.Optional(
        Type.String({ description: "Where to write the PNG, relative to the workspace. Defaults to generated/chart-<timestamp>.png. Non-PNG extensions are changed to .png." }),
      ),
      title: Type.Optional(Type.String({ description: "Chart title." })),
      x_label: Type.Optional(Type.String({ description: "X axis label." })),
      y_label: Type.Optional(Type.String({ description: "Y axis label." })),
      width: Type.Optional(Type.Number({ description: `PNG width in pixels. Defaults to ${DEFAULT_WIDTH}.` })),
      height: Type.Optional(Type.Number({ description: `PNG height in pixels. Defaults to ${DEFAULT_HEIGHT}.` })),
      color: Type.Optional(Type.String({ description: "Hex color, rgb(r,g,b), or supported color name for marks/line. Defaults to #2563eb." })),
    }),
    execute: async (
      _id,
      params: {
        chart_type: ChartType;
        data: RawDatum[];
        output_path?: string;
        title?: string;
        x_label?: string;
        y_label?: string;
        width?: number;
        height?: number;
        color?: string;
      },
    ) => {
      const rawPath = ensurePngExtension(params.output_path?.trim() || defaultChartPath());
      const decision = checkPath(ctx.jail, rawPath, "write");
      if (!decision.allowed) {
        throw new Error(decision.reason ?? `${rawPath} is outside this channel's workspace.`);
      }
      if (existsSync(decision.resolved)) {
        throw new Error(`${rawPath} already exists. Pick a new output_path rather than overwriting it.`);
      }

      const width = Math.round(params.width ?? DEFAULT_WIDTH);
      const height = Math.round(params.height ?? DEFAULT_HEIGHT);
      if (width < 300 || width > 2400) throw new Error("width must be between 300 and 2400 pixels.");
      if (height < 240 || height > 1600) throw new Error("height must be between 240 and 1600 pixels.");

      const { points, categoricalX } = prepareData(params.chart_type, params.data);
      const png = renderChartPng({
        chartType: params.chart_type,
        points,
        categoricalX,
        ...(params.title ? { title: params.title } : {}),
        ...(params.x_label ? { xLabel: params.x_label } : {}),
        ...(params.y_label ? { yLabel: params.y_label } : {}),
        width,
        height,
        color: params.color ?? "#2563eb",
      });

      mkdirSync(dirname(decision.resolved), { recursive: true });
      writeFileSync(decision.resolved, png);

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Created ${rawPath} (${params.chart_type} PNG chart, ${points.length} data point${points.length === 1 ? "" : "s"}). ` +
              (ctx.canUpload
                ? `Use upload_file with path \`${rawPath}\` to share it in ${ctx.channelLabel}; Slack can preview PNG charts inline.`
                : `The chart is in the workspace at \`${rawPath}\`.`),
          },
        ],
        details: { path: rawPath, chartType: params.chart_type, points: points.length, mimeType: "image/png" },
      };
    },
  });

  return [tool] as ToolDefinition[];
}
