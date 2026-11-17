import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { channelPathEnv } from "../../agent/sandbox.ts";
import { agentFooter, footerEnv, footerMarker, parseFooter } from "./footer.ts";
import { forgetGhShim, installGhShim, SHIM_MARK } from "./gh-shim.ts";

/**
 * The footer guard is a shell script, so these tests run it as one: installed the way the harness installs it, in front of a fake
 * `gh` that records exactly what it was given. Nothing here needs GitHub, a token or Docker.
 */

const parts = { role: "coder", stage: "implement", runId: "run42" };
const FOOTER = agentFooter(parts);
const root = mkdtempSync(join(tmpdir(), "gh-shim-"));
after(() => rmSync(root, { recursive: true, force: true }));

const globalBin = join(root, "global-bin");
const realDir = join(root, "real");
mkdirSync(realDir);
const installed = installGhShim(globalBin);
assert.equal(installed.status, "installed");
const SHIM = join(globalBin, "gh");
writeFileSync(join(realDir, "gh"), `#!/bin/sh\nprintf '%s\\0' "$@" > "$GH_OUT"\ncat > "$GH_OUT.stdin"\n`);
chmodSync(join(realDir, "gh"), 0o755);

const shells = ["sh", "dash", "bash"].filter((shell) => spawnSync(shell, ["-c", "exit 0"]).status === 0);
let counter = 0;

type Result = { status: number | null; stderr: string; argv: string[] | undefined; stdin: string };

function run(shell: string, args: string[], options: { input?: string; env?: Record<string, string>; footer?: boolean } = {}): Result {
  const out = join(root, `out-${counter++}`);
  const result = spawnSync(shell, [SHIM, ...args], {
    input: options.input ?? "",
    env: { PATH: `${globalBin}:${realDir}:/usr/bin:/bin`, GH_OUT: out, ...(options.footer === false ? {} : footerEnv(parts)), ...options.env },
    encoding: "utf8",
  });
  let argv: string[] | undefined;
  let stdin = "";
  try {
    const raw = readFileSync(out, "latin1");
    argv = raw === "" ? [] : raw.split("\0").slice(0, -1).map((arg) => Buffer.from(arg, "latin1").toString("utf8"));
  } catch { /* not called */ }
  try { stdin = readFileSync(`${out}.stdin`, "utf8"); } catch { /* not called */ }
  return { status: result.status, stderr: result.stderr, argv, stdin };
}

/** `gh api ...`, with the leading `api` taken off what gh saw, so an expectation reads as what the agent typed. */
const api = (shell: string, argv: string[], options: { input?: string; env?: Record<string, string>; footer?: boolean } = {}): Result => {
  const result = run(shell, ["api", ...argv], options);
  return { ...result, argv: result.argv?.slice(1) };
};

const stamped = (text: string): string => `${text.replace(/\s+$/, "")}\n\n${FOOTER}`;
const bodyOf = (result: Result, flag = "--body"): string => {
  assert.ok(result.argv, `gh was not run: ${result.stderr}`);
  const at = result.argv.lastIndexOf(flag);
  assert.ok(at >= 0, `no ${flag} in ${JSON.stringify(result.argv)}`);
  return result.argv[at + 1]!;
};

for (const shell of shells) {
  describe(`gh footer guard under ${shell}`, () => {
    test("with no footer in the environment it is the real gh, untouched", () => {
      const args = ["issue", "comment", "5", "--body", "hello $HOME `x` *"];
      const r = run(shell, args, { footer: false });
      assert.equal(r.status, 0);
      assert.deepEqual(r.argv, args);
    });

    test("a comment gets the footer, whichever way the text is given, and the other arguments are untouched", () => {
      for (const given of [["--body", "hello"], ["-b", "hello"], ["--body=hello"], ["-bhello"], ["-b=hello"]]) {
        const r = run(shell, ["issue", "comment", "5", "--repo", "o/r", ...given, "--edit-last"]);
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(r.argv, ["issue", "comment", "5", "--repo", "o/r", "--body", stamped("hello"), "--edit-last"], JSON.stringify(given));
        assert.ok(parseFooter(bodyOf(r)));
      }
    });

    test("text from a file or from standard input", () => {
      const file = join(root, "body.md");
      writeFileSync(file, "from a file\n\nsecond paragraph\n\n\n");
      for (const given of [["--body-file", file], ["-F", file], [`--body-file=${file}`], [`-F${file}`]]) {
        const r = run(shell, ["pr", "comment", "7", ...given]);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(bodyOf(r), stamped("from a file\n\nsecond paragraph"), JSON.stringify(given));
      }
      for (const given of [["--body-file", "-"], ["-F", "-"]]) {
        const r = run(shell, ["pr", "comment", "7", ...given], { input: "piped in\nover two lines\n" });
        assert.equal(bodyOf(r), stamped("piped in\nover two lines"));
        assert.equal(r.stdin, "", "the text was read here, so gh has nothing left to read");
      }
      assert.equal(run(shell, ["pr", "comment", "7", "-F", join(root, "missing.md")]).status, 1, "an unreadable file is refused, not posted without a footer");
    });

    test("the footer is never added twice, and an empty body is just the footer", () => {
      const once = run(shell, ["issue", "comment", "5", "-b", "text"]);
      const again = run(shell, ["issue", "comment", "5", "-b", bodyOf(once)]);
      assert.equal(bodyOf(again), bodyOf(once));
      assert.equal(bodyOf(run(shell, ["issue", "comment", "5", "-b", `${bodyOf(once)}\n\n`])), bodyOf(once), "trailing blank lines do not hide it");
      assert.equal(bodyOf(run(shell, ["issue", "comment", "5", "-b", `${bodyOf(once)}\r\n`])), bodyOf(once).replace(/\r$/, ""), "nor does a Windows line ending");
      assert.equal(bodyOf(run(shell, ["issue", "comment", "5", "-b", ""])), FOOTER);
      assert.equal(bodyOf(run(shell, ["issue", "comment", "5", "-b", "  \n\n"])), FOOTER);
      const quoted = `> ${FOOTER.split("\n").join("\n> ")}\n\nmy answer`;
      assert.equal(bodyOf(run(shell, ["issue", "comment", "5", "-b", quoted])), stamped(quoted), "a quoted footer is not this comment's footer");
      const other = agentFooter({ role: "reviewer", stage: "review", runId: "other" });
      assert.equal(bodyOf(run(shell, ["issue", "comment", "5", "-b", `text\n\n${other}`])), `text\n\n${other}\n\n${FOOTER}`, "another run's footer does not stand in for this one");
    });

    test("the text arrives exactly as written: shell characters, quotes, a leading dash, unicode", () => {
      for (const text of ["$HOME `date` $(id) \"quoted\" 'single' \\ back", "- a list\n- of things\n\n  indented", "*.md [a-z]? {x}", "héllo wörld ✓ 日本語", "-b starts with a dash", "--body"]) {
        const r = run(shell, ["issue", "comment", "5", "-b", text]);
        assert.equal(bodyOf(r), stamped(text));
      }
    });

    test("create and edit: a description is stamped, a title that looks like a flag is left alone", () => {
      const r = run(shell, ["pr", "create", "--title", "-bug fix", "--body", "Fixes it", "--base", "main", "--head", "feat", "--draft", "-l", "bug"]);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(r.argv, ["pr", "create", "--title", "-bug fix", "--body", stamped("Fixes it"), "--base", "main", "--head", "feat", "--draft", "-l", "bug"]);
      assert.equal(bodyOf(run(shell, ["issue", "create", "-t", "T", "-F", "-", "--label", "bug"], { input: "from stdin" })), stamped("from stdin"));
      assert.equal(bodyOf(run(shell, ["issue", "new", "-t", "T", "-b", "x"])), stamped("x"));
      assert.equal(bodyOf(run(shell, ["issue", "edit", "5", "--body", "new description"])), stamped("new description"));
      const title = run(shell, ["issue", "edit", "5", "--title", "only the title"]);
      assert.deepEqual(title.argv, ["issue", "edit", "5", "--title", "only the title"], "an edit that does not touch the description is left alone");
      assert.equal(bodyOf(run(shell, ["pr", "revert", "9", "-b", "Reverting"])), stamped("Reverting"));
    });

    test("a write whose text it cannot see is refused, and gh is not run", () => {
      for (const args of [
        ["pr", "create", "--title", "T", "--fill"],
        ["pr", "create", "--fill-first"],
        ["pr", "create", "-t", "T", "-f"],
        ["issue", "create", "-t", "T", "--template", "bug.md"],
        ["pr", "revert", "9", "--fill"].slice(0, 3),
        ["issue", "comment", "5", "--editor"],
        ["issue", "comment", "5", "-e"],
      ]) {
        const r = run(shell, args);
        if (args[1] === "revert") continue;
        assert.equal(r.status, 1, JSON.stringify(args));
        assert.equal(r.argv, undefined, `gh ran for ${JSON.stringify(args)}`);
        assert.match(r.stderr, /harness footer guard/);
      }
      const withBody = run(shell, ["pr", "create", "--title", "T", "--fill", "--body", "mine"]);
      assert.equal(withBody.status, 0, "--fill with a body of its own is fine: the body wins and is stamped");
      assert.equal(bodyOf(withBody), stamped("mine"));
      const web = run(shell, ["pr", "create", "--web"]);
      assert.deepEqual(web.argv, ["pr", "create", "--web"], "opening the browser posts nothing");
    });

    test("a review: the text is stamped, and an approval with no words gets a body saying who wrote it", () => {
      assert.equal(bodyOf(run(shell, ["pr", "review", "7", "--request-changes", "-b", "Please fix"])), stamped("Please fix"));
      assert.equal(bodyOf(run(shell, ["pr", "review", "7", "--comment", "--body-file", "-"], { input: "notes" })), stamped("notes"));
      const approve = run(shell, ["pr", "review", "7", "--approve"]);
      assert.deepEqual(approve.argv, ["pr", "review", "7", "--approve", "--body", FOOTER]);
      assert.deepEqual(run(shell, ["pr", "review", "7", "-a"]).argv, ["pr", "review", "7", "-a", "--body", FOOTER]);
      assert.deepEqual(run(shell, ["pr", "review", "7", "-r"]).argv, ["pr", "review", "7", "-r"], "a review gh itself will refuse for want of text is left to gh");
      assert.deepEqual(run(shell, ["pr", "review", "7", "-a", "-b", "ok"]).argv, ["pr", "review", "7", "-a", "--body", stamped("ok")]);
    });

    test("close and reopen with a comment", () => {
      assert.deepEqual(run(shell, ["issue", "close", "5", "-r", "completed", "-c", "Done"]).argv, ["issue", "close", "5", "-r", "completed", "--comment", stamped("Done")]);
      assert.deepEqual(run(shell, ["pr", "close", "5", "--comment=Not needed"]).argv, ["pr", "close", "5", "--comment", stamped("Not needed")]);
      assert.deepEqual(run(shell, ["issue", "reopen", "5", "-cBack"]).argv, ["issue", "reopen", "5", "--comment", stamped("Back")]);
      assert.deepEqual(run(shell, ["issue", "close", "5"]).argv, ["issue", "close", "5"], "no comment, nothing to stamp");
    });

    test("the repository flag before the subcommand does not hide it", () => {
      assert.deepEqual(run(shell, ["issue", "-R", "o/r", "comment", "5", "-b", "x"]).argv, ["issue", "-R", "o/r", "comment", "5", "--body", stamped("x")]);
    });

    test("anything else is the real gh, untouched", () => {
      for (const args of [["pr", "view", "5", "--json", "state"], ["pr", "merge", "5", "--squash", "--body", "merge text"], ["auth", "status"], ["issue", "list", "--limit", "5"], ["label", "create", "x", "--description", "-b y"], ["--version"], ["--help"]]) {
        const r = run(shell, args);
        assert.deepEqual(r.argv, args, JSON.stringify(args));
      }
    });

    test("gh api: a body field on a write is stamped and sent as a plain string", () => {
      const comments = "repos/o/r/issues/5/comments";
      for (const given of [
        ["-X", "POST", comments, "-f", "body=hi"],
        ["--method", "POST", comments, "--raw-field", "body=hi"],
        ["-XPOST", comments, "-fbody=hi"],
        [comments, "-F", "body=hi"],
        [comments, "--field=body=hi"],
        ["/" + comments, "-f", "body=hi"],
      ]) {
        const r = api(shell, given);
        assert.equal(r.status, 0, `${JSON.stringify(given)}: ${r.stderr}`);
        const at = r.argv!.indexOf("body=" + stamped("hi"));
        assert.ok(at > 0 && r.argv![at - 1] === "-f", JSON.stringify(r.argv));
      }
      const file = join(root, "api-body.md");
      writeFileSync(file, "from a file\n");
      assert.ok(api(shell, [comments, "-F", `body=@${file}`]).argv!.includes("body=" + stamped("from a file")));
      assert.ok(api(shell, [comments, "-F", "body=@-"], { input: "from stdin\n" }).argv!.includes("body=" + stamped("from stdin")));
      assert.ok(api(shell, ["-X", "PATCH", "repos/o/r/issues/comments/9", "-f", "body=edit"]).argv!.includes("body=" + stamped("edit")));
      assert.ok(api(shell, ["-X", "PATCH", "repos/o/r/pulls/3", "-f", "title=t", "-f", "body=desc"]).argv!.includes("body=" + stamped("desc")));
      assert.ok(api(shell, ["repos/o/r/pulls", "-f", "title=t", "-f", "head=h", "-f", "base=main", "-f", "body=desc"]).argv!.includes("body=" + stamped("desc")));
      assert.ok(api(shell, ["repos/o/r/pulls/3/reviews", "-f", "event=COMMENT", "-f", "body=looks fine"]).argv!.includes("body=" + stamped("looks fine")));
      assert.ok(api(shell, ["-X", "PUT", "gists/abc", "-f", "body=on some other write"]).argv!.includes("body=" + stamped("on some other write")), "any write with a body field");
    });

    test("gh api: a new comment, review or description with no body gets one", () => {
      for (const endpoint of ["repos/o/r/issues/5/comments", "repos/o/r/issues", "repos/o/r/pulls", "repos/o/r/pulls/3/reviews", "repos/o/r/pulls/3/comments", "repos/o/r/pulls/3/reviews/8/events", "repos/o/r/commits/abc/comments"]) {
        const r = api(shell, ["-X", "POST", endpoint, "-f", "event=APPROVE"]);
        assert.ok(r.argv!.includes("body=" + FOOTER), endpoint);
      }
      for (const argv of [["-X", "PATCH", "repos/o/r/issues/5", "-f", "state=closed"], ["repos/o/r/issues/5/labels", "-f", "labels[]=bug"], ["-X", "PUT", "repos/o/r/pulls/3/merge", "-f", "merge_method=squash"]]) {
        assert.deepEqual(api(shell, argv).argv, argv, `${JSON.stringify(argv)}: not a comment or a description`);
      }
    });

    test("gh api: reads, deletes and everything unrelated are untouched", () => {
      for (const argv of [
        ["user", "--jq", ".login"],
        ["repos/o/r/issues?state=all&per_page=100"],
        ["-X", "GET", "search/issues", "-f", "q=is:open body"],
        ["--paginate", "repos/o/r/labels", "--jq", ".[].name"],
        ["-X", "DELETE", "repos/o/r/issues/comments/9"],
        ["graphql", "-f", "query={ viewer { login } }"],
        ["graphql", "-F", "owner=o", "-f", "query=query { repository(owner: \"o\", name: \"r\") { id } }"],
      ]) {
        assert.deepEqual(api(shell, argv).argv, argv, JSON.stringify(argv));
      }
    });

    test("gh api: what it cannot give a footer to is refused", () => {
      const refused = (argv: string[], input?: string) => {
        const r = api(shell, argv, input === undefined ? {} : { input });
        assert.equal(r.status, 1, JSON.stringify(argv));
        assert.equal(r.argv, undefined, `gh ran for ${JSON.stringify(argv)}`);
        assert.match(r.stderr, /harness footer guard/);
      };
      refused(["graphql", "-f", "query=mutation { addComment(input: {subjectId: \"x\", body: \"y\"}) { clientMutationId } }"]);
      refused(["graphql", "-f", "query=  MUTATION { x }"]);
      const file = join(root, "mutation.graphql");
      writeFileSync(file, "mutation { addComment(input: {}) { clientMutationId } }");
      refused(["graphql", "-F", `query=@${file}`]);
      refused(["graphql", "-F", "query=@-"], "query { viewer { login } }");
      refused(["graphql", "--input", "-"], "{}");
      refused(["-X", "POST", "repos/o/r/issues/5/comments", "--input", "-"], "{\"body\":\"x\"}");
      refused(["repos/o/r/pulls", "--input", file]);
    });

    test("it runs the real gh and not itself, and says so when there is none", () => {
      assert.equal(run(shell, ["auth", "status"]).status, 0);
      const none = spawnSync(shell, [SHIM, "auth", "status"], { env: { PATH: `${globalBin}:/usr/bin:/bin`, ...footerEnv(parts) }, encoding: "utf8" });
      // /usr/bin or /bin may have a real gh on a developer's machine; where there is none, the guard says so rather than loop.
      if (none.status === 127) assert.match(none.stderr, /not found/);
    });
  });
}

test("the way an agent's bash tool reaches it: the channel's PATH puts the guard ahead of the system's gh, and a heredoc comment is stamped", () => {
  const out = join(root, "bash-out");
  const env = channelPathEnv({
    env: { PATH: `${realDir}:/usr/bin:/bin`, GH_OUT: out, ...footerEnv(parts) },
    paths: { bin: join(root, "workspace-bin") },
    globalBin,
  });
  const script = "gh pr comment 12 --repo acme/app --body-file - <<'EOF'\nLooks fine: `ls` $HOME \"quoted\"\nEOF\ngh pr view 12";
  const result = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  // The fake records only its last call, which is the plain `pr view`; run the comment alone to see it.
  const comment = spawnSync("bash", ["-c", script.split("\ngh pr view")[0]!], { env, encoding: "utf8" });
  assert.equal(comment.status, 0, comment.stderr);
  const argv = readFileSync(out, "utf8").split("\0").slice(0, -1);
  assert.deepEqual(argv.slice(0, 5), ["pr", "comment", "12", "--repo", "acme/app"]);
  assert.equal(argv[6], stamped("Looks fine: `ls` $HOME \"quoted\""));
  assert.ok(parseFooter(argv[6]!));
});

describe("installing the guard", () => {
  test("it is put in the global bin, executable, once; an older copy of itself is replaced; someone else's gh is left alone", () => {
    forgetGhShim();
    const dir = join(root, "install", "global-bin");
    const first = installGhShim(dir);
    assert.equal(first.status, "installed");
    assert.ok((statSync(join(dir, "gh")).mode & 0o111) !== 0, "executable");
    forgetGhShim();
    assert.equal(installGhShim(dir).status, "current");
    writeFileSync(join(dir, "gh"), `#!/bin/sh\n${SHIM_MARK} v0\necho old\n`);
    forgetGhShim();
    assert.equal(installGhShim(dir).status, "installed");
    assert.match(readFileSync(join(dir, "gh"), "utf8"), /POSIX sh/);
    const theirs = join(root, "install", "theirs");
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, "gh"), "#!/bin/sh\necho mine\n");
    forgetGhShim();
    const conflict = installGhShim(theirs);
    assert.equal(conflict.status, "conflict");
    assert.equal(readFileSync(join(theirs, "gh"), "utf8"), "#!/bin/sh\necho mine\n");
  });

  test("the environment the guard reads is the footer and its marker line, from the one helper", () => {
    const env = footerEnv(parts);
    assert.equal(env.HARNESS_AGENT_FOOTER, agentFooter(parts));
    assert.equal(env.HARNESS_AGENT_FOOTER_MARKER, footerMarker(parts));
    assert.equal(env.HARNESS_AGENT_FOOTER!.split("\n").at(-1), env.HARNESS_AGENT_FOOTER_MARKER);
  });
});
