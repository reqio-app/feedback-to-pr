/**
 * Thin client for the Reqio v1 REST API (ADR 0020).
 *
 * Every response is wrapped in a `{ data }` envelope by the server's handleApi
 * pipeline, so nothing here returns a bare body. The API key is audience-bound
 * to one project server-side; presenting it against a different project id
 * fails closed rather than reading someone else's backlog.
 */

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

export const config = () => {
  const baseUrl = (process.env.REQIO_BASE_URL || "https://reqio.app").replace(/\/+$/, "");
  return {
    baseUrl,
    projectId: required("REQIO_PROJECT_ID"),
    apiKey: required("REQIO_API_KEY"),
  };
};

const request = async (cfg, method, path, body) => {
  const url = `${cfg.baseUrl}/p/${cfg.projectId}/api/v1${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // fall through to the status-based error below
  }

  if (!response.ok) {
    const code = parsed?.error?.code || parsed?.error || response.status;
    // 401 here almost always means the key was minted for another project, or
    // the owner's plan lost apiKeysEnabled. The server deliberately does not
    // say which, so neither can we.
    throw new Error(`${method} ${path} failed: ${code}`);
  }
  return parsed?.data ?? null;
};

/**
 * The v1 API is not uniform: paged collections return `{items, hasMore,
 * nextCursor}` while conversation messages return a bare array. Assuming
 * `.items` everywhere silently yields an empty thread rather than an error,
 * which would strip the reporter's replies out of the agent's brief without
 * anything failing. Normalise instead of guessing.
 */
const asList = (data) => (Array.isArray(data) ? data : (data?.items ?? []));

export const listFeatures = async (cfg, { status, category }) => {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (category) params.set("category", category);
  const items = [];
  let cursor = null;
  do {
    if (cursor) params.set("cursor", cursor);
    const page = await request(cfg, "GET", `/features?${params.toString()}`);
    items.push(...asList(page));
    cursor = page?.nextCursor ?? null;
  } while (cursor);
  return items;
};

export const getFeature = (cfg, featureId) => request(cfg, "GET", `/features/${featureId}`);

/** Returns null when the report carries no screenshot, which is common and not an error. */
export const getScreenshot = async (cfg, featureId) => {
  try {
    return await request(cfg, "GET", `/features/${featureId}/screenshot`);
  } catch {
    return null;
  }
};

/**
 * The v1 conversations list carries featureId, so a bug's private thread is
 * found by filtering it. There is no feature-to-conversation link on the
 * feature detail itself.
 */
export const getConversationThread = async (cfg, featureId) => {
  try {
    const page = await request(cfg, "GET", "/conversations");
    const match = asList(page).find((row) => row.featureId === featureId);
    if (!match) return null;
    const messages = await request(cfg, "GET", `/conversations/${match.id}/messages`);
    return { conversationId: match.id, messages: asList(messages) };
  } catch {
    return null;
  }
};

/**
 * Replaces this action's zone of the developer note, leaving the human's brief
 * above the marker untouched. The server does the splice inside a row lock, so
 * a teammate editing the note at the same moment cannot lose either side.
 *
 * Deliberately not the whole-note PATCH: that endpoint still exists for humans
 * deliberately rewriting everything, and using it here destroyed the spec the
 * agent had just been handed.
 */
export const setDeveloperNoteAgentSection = (cfg, featureId, text) =>
  request(cfg, "PUT", `/features/${featureId}/developer-note/agent-section`, { text });

export const setStatus = (cfg, featureId, status, completionKind) =>
  request(cfg, "PATCH", `/features/${featureId}`, {
    status,
    ...(completionKind ? { completionKind } : {}),
  });

/**
 * Best-effort: a dead Slack webhook must never fail a run whose pull request
 * actually opened. The server is already fire-and-forget on its side; this
 * guards the network hop to it.
 */
export const emitAgentEvent = async (cfg, payload) => {
  try {
    await request(cfg, "POST", "/agent-events", payload);
  } catch (error) {
    console.warn(`[reqio] agent event ${payload.kind} not delivered: ${error.message}`);
  }
};

/**
 * ADR 0021's claim/reserve call. The server's contract promises this
 * endpoint always answers HTTP 200 with one of its documented shapes, but
 * that is a promise about the server, not about the network between here and
 * it: a proxy 502, a timeout, or a body that fails to parse never reaches
 * that contract at all. Both a clean decline and an unreachable endpoint
 * collapse to the same `{ claimed: false }` shape here, with a synthetic
 * `reason` the caller can log, because "the server said no" and "the server
 * could not be reached" have to be handled identically by anything about to
 * spend model tokens on the strength of this response: skip, never crash.
 *
 * `featureId` is required by the schema even for a dry run - see
 * agentClaimApiSchema server-side - but the dry-run branch does not resolve
 * it against a real feature, so a caller with nothing to test against yet
 * (verify mode on a brand new project) can pass a placeholder.
 */
export const claimAgentLoop = async (cfg, featureId, { dryRun } = {}) => {
  try {
    const result = await request(cfg, "POST", "/agent-claims", {
      featureId,
      ...(dryRun ? { dryRun: true } : {}),
    });
    if (result && typeof result.claimed === "boolean") return result;
    return { claimed: false, reason: "malformed_response", quota: null };
  } catch (error) {
    return { claimed: false, reason: "request_failed", quota: null, error: error.message };
  }
};
