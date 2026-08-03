# reqio-app/feedback-to-pr

Turn approved [Reqio](https://reqio.app) bug reports into pull requests, and tell the person who reported it when you merge.

```
bug reported in your product
        ↓
team moves it to In progress
        ↓
this action opens a pull request
        ↓
you review  ──→  ask for changes, the agent revises it
        ↓                        ↑
        └────────────────────────┘
        ↓
you merge
        ↓
the reporter gets an email saying it shipped
```

That last arrow is the point. Your users find out what happened to the thing they told you about.

## How it is wired

Reqio never calls your repository and never holds a credential for it. A scheduled workflow in **your** repo asks Reqio whether there is anything to do. The trust runs one way: your CI reaches into Reqio, never the reverse.

That means Reqio cannot see your code, cannot push to your branches, and has nothing to leak if it is ever breached.

The cost is latency. GitHub's cron drifts by 10 to 40 minutes and stops entirely after 60 days without a commit. For "a bug becomes a pull request" that is fine, and `workflow_dispatch` gives you a Run workflow button when you don't want to wait.

### A note on Actions minutes if your repo is private

Public repositories get unlimited free Actions minutes. Private ones are metered, and **GitHub rounds every job up to a whole minute**. A poll that finds no work exits in about three seconds and still bills a full minute.

That is why the default schedule is every four hours rather than hourly: roughly 180 billed minutes a month instead of 730, out of the 2,000 the free tier includes. Tighten the cron if you want lower latency and have the minutes to spend, and use Run workflow when you want a result immediately.

## Setup

Your Reqio dashboard generates both workflow files pre-filled for your project: **Project → Settings → Agent**. Copy them in, add two secrets, done.

If you would rather write them by hand, see [`examples/`](./examples).

### Run verify first

The generated poll workflow ships a second job, `verify`, gated on `workflow_dispatch` with `mode: verify`. Run it from the Actions tab before you trust the schedule with anything. It authenticates, lists what's currently In progress, reads one request and its screenshot, and checks this month's quota, in that order, and it never touches your model or spends a loop doing it. If a step fails, the job summary names exactly which one, so you fix your setup before the schedule wastes an unattended run finding the same thing out.

### Secrets

| Secret | What it is |
|---|---|
| `REQIO_API_KEY` | A project API key from Project → Settings → API. Needs `backlog:read`, `conversations:read`, `notes:write`, `status:write`, `agent:claim`. A key minted before `agent:claim` existed does not have it - re-mint it at Settings → API and update the secret. `verify` names this exact problem when it is the cause. |
| `ANTHROPIC_API_KEY` | The coding agent's model key. Swap the name if you use `agent-command` to run a different agent. |

Both are used only inside your own runner. Reqio never sees the model key, and the model never sees your Reqio key.

### Inputs

| Input | Default | Notes |
|---|---|---|
| `mode` | `poll` | `poll` (the schedule), `verify` (dry run, see above), `review`, or `merged`. The generated workflows set this for you. |
| `project-id` | required | Your Reqio project id. |
| `base-url` | `https://reqio.app` | No trailing slash. |
| `auto-approve` | `false` | `false`: only bugs your team moved to In progress. `true`: also picks up new bugs, and the pull request becomes the only approval. |
| `max-prs-per-run` | `3` | Stops a backlog flood becoming a review avalanche. |
| `test-command` | empty | Runs before the PR opens. See the CI caveat below. |
| `allow-test-edits` | `false` | Keeps the agent out of your test files. |
| `agent-command` | Claude Code | Any CLI that reads a brief on stdin and edits the checkout in place. |
| `base-branch` | repo default | Branch to cut from. |
| `pr-number` | empty | Review mode only. The pull request that was reviewed. |
| `completion-kind` | `NEXT_UPDATE` | Merge mode only. `SHIPPED` if merging deploys for you. |

## Monthly quota

Every plan includes a monthly number of agent loops, pooled across every project you own - Free is 10, and it is enough to run this end to end on a hobby project. Before the model runs, poll mode reserves one unit of that quota for the request it is about to work on. Reserving is free the second time: resuming a draft or answering a round of review questions on a request you already claimed never counts again.

**Running out is not a failure.** If a request would put you over quota, or the agent is paused for that project, the action skips it, writes one line to the job summary saying why and where your quota stands, and moves to the next candidate. The run still finishes green. A red run in your CI over a free-tier limit would be Reqio's mistake, not yours, so it never happens - check the job summary, not the run status, to see what got skipped. Settings → Agent on your dashboard shows the same number live.

## Upgrading from v1

`v1` predates the quota above. It never calls the claim endpoint, does not support `verify`, and is not metered - Reqio counts its pull requests softly, for visibility only, and never rejects one. It is frozen: existing workflows pinned to `reqio-app/feedback-to-pr@v1` keep working exactly as they always have, with no quota enforcement, whether or not you touch them.

`v2` is additive on top of it - same inputs, same modes, same behaviour for everything except the two changes above. To move onto it:

1. Point your workflow files at `reqio-app/feedback-to-pr@v2` instead of `@v1`.
2. Re-mint `REQIO_API_KEY` with the `agent:claim` scope included (see Secrets above).
3. Run `verify` once from the Actions tab to confirm both landed.

Nothing else changes. There is no reason to stay on `v1` once `agent:claim` is on your key, and every new setup generated from the dashboard already targets `v2`.

## Asking the agent for changes

The third workflow, [`reqio-agent-review.yml`](./examples/reqio-agent-review.yml), is optional. Without it a pull request is take-it-or-leave-it: if the agent gets it 80% right you finish the last 20% by hand and it never hears about the correction.

With it, you review the way you would review a colleague:

- Leave a comment containing **`/reqio`** anywhere on the pull request, on the conversation tab or on a specific line.
- Or submit a review with **Request changes**, which needs no keyword because the state already is the request.

The agent checks out the pull request head, reads every comment left since its last push, and pushes a commit on top. It does not start over: the diff you reviewed is in its brief, and it is told to amend that, not to re-solve the problem. Then it replies on the pull request saying what it did.

If a comment is ambiguous enough that it would be guessing, it makes no change and posts its questions instead. Those stay on the pull request. They are never relayed to the person who reported the bug, who did not ask to be consulted about your code.

Four things worth knowing:

**Only collaborators can trigger it.** The workflow checks `author_association` and so does the action. On a public repo, without that, a stranger's comment would spend your model key in your runner.

**It refuses to run against a fork, and that refusal does not live in your workflow file.** `issue_comment` - the Conversation-tab trigger - carries no repository information on its payload at all, only an issue number, so there is no `head.repo.fork` for a YAML `if:` to check on that event. The other two events do carry it and the example workflow checks it, but a workflow file is something you can loosen later, or a generated one you might not copy exactly. The action itself asks GitHub whether the pull request is cross-repository before it checks anything out, and refuses loudly if it is, regardless of what triggered the run or what your `if:` says. That check, not the YAML, is what actually stops a forked pull request from running with your `contents: write` token and your job's secrets.

**Comments are fenced like reporter text.** A reviewer has push access, so their words are far more trusted than a bug report, but the fence stays. `author_association` and the fork check above are real protection, but they are still one compromised collaborator account away from a bad day, and the fence limits what that day costs you.

**It pushes, it never force-pushes.** Poll mode rebuilds the branch from base and force-pushes; this mode adds a commit to the exact head you read. If someone pushed while the agent was working, the push loses, and it tells you rather than overwriting the work.

## Two things worth knowing before you turn this on

**Your CI will not run on these pull requests.** GitHub deliberately suppresses workflow triggers for anything done with the default `GITHUB_TOKEN`, to stop workflows triggering each other forever. So your tests, linter and type check do not run on the agent's branch. Set `test-command` and the action runs your suite inside its own job and puts the result in the PR body, so nothing untested reaches a reviewer. If you need real check runs, pass a PAT or a GitHub App installation token as `github-token`.

**Agent output on vague reports is poor.** "The button is confusing" is not a specification. When the agent cannot reproduce or understand a report it writes its questions to `.reqio-agent/questions.md`, makes no code changes, and opens a **draft** pull request instead of guessing. Those questions also land on the request in Reqio, where your team can answer them or forward them to the reporter. A confident wrong pull request is worse than no pull request.

Repositories without a test suite get noticeably worse results, because the agent has no way to check itself.

## Safety

- Bug reports are text written by strangers, and it becomes an agent prompt next to repo write access. Report content is fenced and labelled as untrusted data in the brief, and the agent is told that instructions found inside it are to be reported, not followed.
- The agent, and `test-command` after it, run with an **allowlisted** environment, not your job's whole one. `GH_TOKEN` and `REQIO_API_KEY` are never on that list, and neither is a deploy token, a database URL, or a registry token your job declares for its own reasons. Only model-provider variables and ordinary runner plumbing (`PATH`, `HOME`, proxy settings, and the like) get through. This is deliberately a fixed list in the action's code, not a passthrough you configure on the job - see `AGENT_ENV_ALLOWLIST` in `scripts/main.mjs` if `agent-command` targets a provider not already on it.
- **One caveat on that list, stated plainly.** Running a model through Amazon Bedrock or Google Vertex needs general-purpose cloud credentials, so `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and `GOOGLE_APPLICATION_CREDENTIALS` are on the allowlist. Unlike a provider API key, those grant whatever the underlying IAM principal grants, not just model access. If you use one of those providers, give this job a credential scoped to model invocation alone. If you do not use them but have AWS or Google credentials on this job for deployment, they will reach the agent: move that work to a separate job. More generally, do not declare a secret on this job that the agent has no reason to see; the allowlist is a second layer, not a substitute for that.
- The workflow asks for `contents: write` and `pull-requests: write` and nothing else.
- The agent never pushes to your default branch. Poll and merged mode never run on fork-originated events at all, and review mode's `runReview` refuses server-side before checkout if the pull request it was asked to act on turns out to be cross-repository - the one case (`issue_comment`) where the workflow's own `if:` cannot express that check. See "Asking the agent for changes" above.
- With `allow-test-edits: false` (the default) any edit the agent makes to a test file is reverted before the commit.
- The API key is audience-bound to one Reqio project server-side. Presented against a different project it fails closed.
- Every pull request is reviewed by a human. Turn on branch protection so that stays true.

## Licence

MIT
