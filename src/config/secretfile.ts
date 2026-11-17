import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Helpers for operator-managed dotenv secret files. Values are never printed. */

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertKey(key: string): void {
  if (!KEY_RE.test(key)) throw new Error(`Invalid secret name: ${key}`);
}

function keyOfLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
  const eq = withoutExport.indexOf("=");
  if (eq <= 0) return undefined;
  const key = withoutExport.slice(0, eq).trim();
  return KEY_RE.test(key) ? key : undefined;
}

export function encodeEnvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]*$/.test(value) && value.length > 0) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"')}"`;
}

export function listSecretKeys(content: string): string[] {
  const keys = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const key = keyOfLine(line);
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

export function setSecretValue(content: string, key: string, value: string): string {
  assertKey(key);
  const rendered = `${key}=${encodeEnvValue(value)}`;
  const lines = content.split(/\r?\n/);
  let replaced = false;
  const out = lines.map((line) => {
    if (keyOfLine(line) === key) {
      replaced = true;
      return rendered;
    }
    return line;
  });

  // Preserve existing comments and spacing; append new keys at the end.
  let text = out.join("\n");
  text = text.replace(/\n*$/, "\n");
  if (!replaced) text += `${rendered}\n`;
  return text;
}

export function removeSecretValue(content: string, key: string): { content: string; removed: boolean } {
  assertKey(key);
  let removed = false;
  const out = content.split(/\r?\n/).filter((line) => {
    if (keyOfLine(line) === key) {
      removed = true;
      return false;
    }
    return true;
  });
  return { content: out.join("\n").replace(/\n*$/, "\n"), removed };
}

export function readSecretFile(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

export function writeSecretFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}
