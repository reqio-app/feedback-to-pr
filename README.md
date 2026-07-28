# reqio-app/feedback-to-pr

Turn approved [Reqio](https://reqio.app) bug reports into pull requests, and tell the person who reported it when you merge.

```
bug reported in your product
        ↓
team moves it to In progress
        ↓
this action opens a pull request
        ↓
you review and merge
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

### Secrets

| Secret | What it is |
|---|---|
| `REQIO_API_KEY` | A project API key from Project → Settings → API. Needs `backlog:read`, `conversations:read`, `notes:write`, `status:write`. |
| `ANTHROPIC_API_KEY` | The coding agent's model key. Swap the name if you use `agent-command` to run a different agent. |

Both are used only inside your own runner. Reqio never sees the model key, and the model never sees your Reqio key.

### Inputs

| Input | Default | Notes |
|---|---|---|
| `project-id` | required | Your Reqio project id. |
| `base-url` | `https://reqio.app` | No trailing slash. |
| `auto-approve` | `false` | `false`: only bugs your team moved to In progress. `true`: also picks up new bugs, and the pull request becomes the only approval. |
| `max-prs-per-run` | `3` | Stops a backlog flood becoming a review avalanche. |
| `test-command` | empty | Runs before the PR opens. See the CI caveat below. |
| `allow-test-edits` | `false` | Keeps the agent out of your test files. |
| `agent-command` | Claude Code | Any CLI that reads a brief on stdin and edits the checkout in place. |
| `base-branch` | repo default | Branch to cut from. |
| `completion-kind` | `NEXT_UPDATE` | Merge mode only. `SHIPPED` if merging deploys for you. |

## Two things worth knowing before you turn this on

**Your CI will not run on these pull requests.** GitHub deliberately suppresses workflow triggers for anything done with the default `GITHUB_TOKEN`, to stop workflows triggering each other forever. So your tests, linter and type check do not run on the agent's branch. Set `test-command` and the action runs your suite inside its own job and puts the result in the PR body, so nothing untested reaches a reviewer. If you need real check runs, pass a PAT or a GitHub App installation token as `github-token`.

**Agent output on vague reports is poor.** "The button is confusing" is not a specification. When the agent cannot reproduce or understand a report it writes its questions to `.reqio-agent/questions.md`, makes no code changes, and opens a **draft** pull request instead of guessing. Those questions also land on the request in Reqio, where your team can answer them or forward them to the reporter. A confident wrong pull request is worse than no pull request.

Repositories without a test suite get noticeably worse results, because the agent has no way to check itself.

## Safety

- Bug reports are text written by strangers, and it becomes an agent prompt next to repo write access. Report content is fenced and labelled as untrusted data in the brief, and the agent is told that instructions found inside it are to be reported, not followed.
- The agent is spawned without this action's credentials. `GH_TOKEN` and `REQIO_API_KEY` are stripped from its environment, and from the environment your `test-command` runs in, since that executes code the agent just wrote. Your model key is passed through; nothing else of ours is.
- The workflow asks for `contents: write` and `pull-requests: write` and nothing else.
- The agent never pushes to your default branch and never runs on fork-originated events.
- With `allow-test-edits: false` (the default) any edit the agent makes to a test file is reverted before the commit.
- The API key is audience-bound to one Reqio project server-side. Presented against a different project it fails closed.
- Every pull request is reviewed by a human. Turn on branch protection so that stays true.

## Licence

MIT
