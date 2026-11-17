import { describe, expect, it } from "vitest";
import type { FactoryRepositoryView } from "@api/api-types";
import { AUTO_REFRESH_MS, countLabel, filterRepository, matches, reviewLabel, safeGithubUrl, shouldAutoRefresh } from "./factory";

const repo: FactoryRepositoryView = {
  repository: "acme/web",
  issues: [
    { number: 12, title: "Login fails on Safari", state: "open", updatedAt: "2026-10-20T00:00:00Z", url: "https://github.com/acme/web/issues/12", labels: [{ name: "bug" }, { name: "p1" }] },
    { number: 30, title: "Add dark mode", state: "open", updatedAt: "2026-10-20T00:00:00Z", url: "https://github.com/acme/web/issues/30" },
  ],
  pullRequests: [
    { number: 41, title: "Fix the login redirect", state: "open", updatedAt: "2026-10-20T00:00:00Z", url: "https://github.com/acme/web/pull/41", reviewDecision: "CHANGES_REQUESTED" },
    { number: 44, title: "Draft: caching", state: "open", updatedAt: "2026-10-20T00:00:00Z", url: "https://github.com/acme/web/pull/44", isDraft: true },
  ],
  merged: [{ number: 40, title: "Bump deps", state: "merged", updatedAt: "2026-10-19T00:00:00Z", url: "https://github.com/acme/web/pull/40", mergedAt: "2026-10-19T00:00:00Z", author: { login: "ana" } }],
};

describe("factory filter", () => {
  it("matches title, #number and labels for issues", () => {
    expect(filterRepository(repo, "login").issues.map((i) => i.number)).toEqual([12]);
    expect(filterRepository(repo, "#30").issues.map((i) => i.number)).toEqual([30]);
    expect(filterRepository(repo, "P1").issues.map((i) => i.number)).toEqual([12]);
  });
  it("matches review decision for pull requests and author for merges", () => {
    expect(filterRepository(repo, "changes requested").pullRequests).toHaveLength(0);
    expect(filterRepository(repo, "changes_requested").pullRequests.map((p) => p.number)).toEqual([41]);
    expect(filterRepository(repo, "ana").merged.map((p) => p.number)).toEqual([40]);
    expect(filterRepository(repo, "zzz")).toMatchObject({ issues: [], pullRequests: [], merged: [], filtered: true });
  });
  it("shows everything for an empty or blank query", () => {
    const all = filterRepository(repo, "  ");
    expect(all.issues).toHaveLength(2);
    expect(all.filtered).toBe(false);
    expect(matches("", undefined)).toBe(true);
  });
  it("labels counts as N of M only while filtering", () => {
    expect(countLabel(1, 2, true)).toBe("1 of 2");
    expect(countLabel(2, 2, false)).toBe("2");
  });
  it("humanises a review decision", () => expect(reviewLabel("CHANGES_REQUESTED")).toBe("changes requested"));
});

describe("links and refresh", () => {
  it("only lets github.com links through", () => {
    expect(safeGithubUrl("https://github.com/acme/web/pull/1")).toBe("https://github.com/acme/web/pull/1");
    for (const bad of ["http://github.com/x", "https://github.com.evil.example/x", "https://evil.example/https://github.com/", "javascript:alert(1)", "", undefined, 5]) {
      expect(safeGithubUrl(bad)).toBeUndefined();
    }
  });
  it("auto-refreshes only while enabled and the page is visible", () => {
    expect(AUTO_REFRESH_MS).toBe(30_000);
    expect(shouldAutoRefresh(true, false)).toBe(true);
    expect(shouldAutoRefresh(true, true)).toBe(false);
    expect(shouldAutoRefresh(false, false)).toBe(false);
  });
});
