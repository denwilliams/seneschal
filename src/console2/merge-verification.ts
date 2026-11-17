import type { IncomingMessage } from "node:http";

export const MERGE_COOKIE = "harness-merge-verification";
export function mergeBrowser(req: IncomingMessage): string {
  const matches = (req.headers.cookie ?? "").split(";").map((value) => value.trim()).filter((value) => value.startsWith(`${MERGE_COOKIE}=`));
  if (matches.length !== 1) return "";
  const value = matches[0]!.slice(MERGE_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : "";
}
