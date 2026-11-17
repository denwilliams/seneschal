---
name: writing-skills
description: "How to write a skill that fires when it should and is worth reading when it does: what goes in the description, what goes in the body, and what should not be a skill at all. Use this before `save_skill` or `publish_skill` — every time, even when the skill seems obvious — and when a skill you wrote did not fire, did not help, or needs revising."
---

# Writing skills

A skill is a note you leave for yourself, to be read on a day when you have
forgotten this entire conversation. Everything below follows from that.

This is Anthropic's skill-creator guidance, cut down to what this harness can
actually do — see *Where this comes from* at the end.

## How a skill reaches you

Skills load in two stages, and the stages have different jobs:

| | Always in your context | Read only when the task matches |
|---|---|---|
| name + description | ✅ | |
| body | | ✅ |

The description is therefore not a summary of the body — it is the **trigger**.
A perfect body behind a vague description is dead weight, because you will
never open it. Write each part for its own job.

## First: should this be a skill at all?

Save one when all three hold:

1. **You worked it out**, and a fresh you would have to work it out again.
2. **It is a procedure** — steps, an order, a format, how a system really
   behaves — not a fact. One sentence of fact is `remember`.
3. **It will still be true next month.** Today's ticket number is not a skill.

Don't save one for something you were asked once, for general competence you
already have (nobody needs a skill on how to write Python), or for a narration
of what you did today. A skill is instructions, not a diary.

The test: *in a fresh conversation next month, would loading this change what I
actually do?* If no, don't save it. Three good skills beat thirty that all
half-match.

Skills you write are instructions someone may later follow without checking
them. Don't write one that would surprise the person who asked for it if they
read it back, and don't write one whose real purpose is something other than
what its description says.

## The description

Two parts, both required: **what it does**, and **when to use it** in the words
a future request will actually arrive in.

```
<What it does, one clause>. Use when <concrete triggers — the phrases,
systems, file types and names people here really say>.
```

- **Name real triggers.** System names, dashboard names, file extensions, the
  in-house phrase for the thing ("the Friday rollup", "the rollup", "weekly
  report" — all three, if all three get used).
- **Use the requester's vocabulary, not your own filing system.** You match
  against how people ask.
- **Lean pushy.** The common failure is *under*-triggering: a skill that exists,
  fits, and never gets opened. If it should fire on a topic even when nobody
  names the skill, say so — "use this whenever someone asks about the alerts,
  even if they don't mention Grafana."
- **Draw the border when a neighbour exists.** "Not for one-off diffs — that is
  `code-review`." Two skills that both half-match is the other common failure.
- **No filler.** "Helps with various tasks", "as needed", "when relevant" match
  nothing. If a clause would be true of half your skills, cut it.
- One to three sentences, present tense.

| Weak | Why it fails | Better |
|---|---|---|
| "Reporting helper." | Matches everything, so it matches nothing. | "Produces the Friday project rollup in the format #ops accepts. Use when someone asks for the rollup, the weekly report, or Friday numbers." |
| "Explains our Grafana setup." | No trigger — you'd have to already know it exists. | "How to read the ops Grafana alerts, including which panels aggregate across nodes and lie. Use whenever an alert fires or a disk or memory number looks wrong, even if nobody says Grafana." |
| "Use this skill for deployments." | Which ones? To do what? | "Runs the staging deploy and the checks after it. Use when asked to deploy, ship or roll back staging; production deploys are a human's job." |

## The body

Write for a competent stranger who happens to be you, minus this conversation.

- **Open with one line**: when this applies, and what "done" looks like.
- **Imperative steps, in the order performed.** "Read the open threads", not
  "threads should be read".
- **Specific enough to follow blind.** "Check the dashboard" is not a step.
  "Open the `ops-overview` dashboard, panel *Disk* — it sums across nodes, so
  divide by the node count before quoting it" is a step.
- **Write down the gotcha.** The thing that cost you twenty minutes is the most
  valuable line in the file, and the one you'll be tempted to leave out because
  right now it feels obvious.
- **Give the format as a template**, not a description of a format, when the
  skill produces something shaped:

  ```
  *Rollup — week of <date>*
  • <project> — <one line, what moved>
  ```

- **Show one worked example** if it's short — the input, and the output that
  was accepted. Examples carry format better than adjectives do.
- **Say why**, not just what. You are writing for a reader who can adapt a rule
  it understands and can only obey one it doesn't. If you catch yourself
  writing ALWAYS or NEVER in capitals, explain the reason instead — the
  exceptions are what the capitals were trying to hide.

Leave out: secrets and tokens (name the environment variable instead); anything
that expires — today's date, a one-time URL, a current ticket number; the story
of the conversation that produced the skill; and restatements of standing
instructions you already follow.

**Keep it lean.** Cut anything not pulling its weight. If it runs past roughly
a screen you have mixed a procedure with a reference — keep the procedure, and
put the facts in memory. Your own skills are a single file: there is no place
to put bundled scripts, so if a procedure needs a tool, write the tool into
`bin/` and have the skill say when to reach for it.

## Draft, use, revise

Write the draft, then read it again as if you had never seen this conversation
— that second pass is where most of the quality comes from. The real test is
the next time the skill fires: notice whether it fired at all, and whether you
followed it or worked around it.

Saving over a name replaces it, and that is how a skill gets good. When one
fails you, fix the line that failed rather than writing a second, nearly
identical skill, and say out loud what you changed. Fix the general problem
rather than patching the one case — a skill is meant to work on requests you
haven't seen yet, not just on the one in front of you.

Delete a skill that has stopped being true. A wrong skill is worse than none,
because you will follow it.

## In this harness

- **The output is Slack.** If the skill produces a message, show the exact
  shape: mrkdwn, no `#` headings.
- **Paths are this channel's.** Your working directory is this channel's own
  workspace, and a script in `bin/` is on PATH — name it, and say what it takes.
- **Skills are plain files** an operator may read and edit by hand. Write so
  someone scanning it can tell what it does.
- **If it might be published to the library**, write it so another channel can
  follow it: state what it assumes about this channel instead of assuming it
  silently. Anything specific to here, keep here.

## Before you call `save_skill`

- [ ] It's a procedure, not a fact, and not a one-off.
- [ ] The description says what it does *and* names triggers in the words
      people here use.
- [ ] The body can be followed by someone who wasn't in this conversation.
- [ ] The gotchas are written down.
- [ ] No secrets, nothing that goes stale.
- [ ] Next month, following this would still be right.

## Where this comes from

Adapted from Anthropic's `skill-creator` skill, in
[anthropics/skills](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md).
That version is written for Claude Code, where a skill is a directory with
bundled scripts and there is an eval harness to measure triggering; most of it
is machinery this harness does not have. What survives the trip is the part
about writing: progressive disclosure, descriptions as triggers, pushiness
against under-triggering, explaining the why instead of shouting rules, and
generalising rather than overfitting to the example in front of you. Read the
original if you want the full version.
