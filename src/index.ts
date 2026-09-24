interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * GLEIF MCP — Global Legal Entity Identifier Foundation (free, no auth)
 *
 * The LEI is the ISO 17442 canonical identifier for any legal entity that's
 * party to a financial transaction (~2.5M issued). Pairs well with EDGAR,
 * OpenCorporates, and OpenSanctions for entity resolution and counterparty
 * due diligence.
 *
 * API: https://www.gleif.org/en/lei-data/gleif-api
 * Tools:
 * - search_lei:           fuzzy-match a legal entity name to an LEI
 * - get_lei:              full LEI record by LEI code (20-char alphanumeric)
 * - get_lei_relationships: parent / ultimate parent / children (Level 2 relationship records)
 * - isin_to_lei:          ISIN -> issuing legal entity (GLEIF ISIN-LEI mapping)
 * - lei_to_isins:         LEI (or name) -> ALL ISINs issued by that entity
 * - bic_to_lei:           SWIFT/BIC -> legal entity (GLEIF BIC-LEI mapping)
 * - lei_hierarchy_tree:   multi-hop ownership tree (ancestor chain + descendant BFS)
 *
 * Mapping gotchas (learned live 2026-08-16):
 * - filter[bic] matches 11-character BICs only — an 8-char head-office BIC
 *   ("DEUTDEFF") returns zero rows until padded to "DEUTDEFFXXX".
 * - /lei-records/{lei}/isins is the reverse mapping and is paginated; one
 *   entity issues MANY securities (Nestlé: 7+), so never collapse it to one.
 * - The mapping files lag issuance: a structurally valid ISIN with no GLEIF
 *   row is UNMAPPED, not nonexistent — report it that way.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Gleif');
}


const BASE_URL = 'https://api.gleif.org/api/v1';

const tools: McpToolExport['tools'] = [
  {
    name: 'search_lei',
    description:
      'Search the GLEIF LEI registry by legal entity name. Returns matched entities with their 20-character LEI, jurisdiction, status, and BIC/ISIN cross-references. Use the LEI to resolve canonical identity across SEC, OpenSanctions, and counterparty databases. ' +
      'Name matching is whole-token AND against the REGISTERED legal name, so abbreviations that do not literally appear ("Microsoft Corp", "Toyota Motor Corp") match nothing on their own; this tool automatically retries with legal-form suffixes dropped, with the words joined ("Exxon Mobil" -> "ExxonMobil"), and finally against GLEIF fuzzy autocomplete. The response always reports `match_mode` and `searched_as` so you can see which query actually produced the rows.',
    summary: 'Legal entities matching a name search, with their LEI codes, from the Global LEI Foundation.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Legal entity name (full or partial), e.g. "Apple Inc." or "Siemens Aktiengesellschaft"' },
        country: {
          type: 'string',
          description:
            'Restrict to the legal address country. ISO 3166-1 alpha-2, e.g. "US", "DE", "JP". Alpha-3 codes and country names are accepted for the common jurisdictions and converted; anything unrecognized is rejected with an error rather than silently returning zero rows.',
        },
        status: {
          type: 'string',
          description:
            'Entity status (ACTIVE | INACTIVE | NULL) or LEI registration status (ISSUED | LAPSED | ANNULLED | PENDING_TRANSFER | PENDING_ARCHIVAL | DUPLICATE | RETIRED | MERGED). GLEIF keeps these in two different fields; the tool routes the value to the right one. "LAPSED" means the LEI registration lapsed, not that the company is gone.',
          enum: [
            'ACTIVE',
            'INACTIVE',
            'NULL',
            'ISSUED',
            'LAPSED',
            'ANNULLED',
            'PENDING_TRANSFER',
            'PENDING_ARCHIVAL',
            'DUPLICATE',
            'RETIRED',
            'MERGED',
          ],
        },
        page_size: { type: 'number', description: '1-200 (default 25)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_lei',
    description:
      'Fetch the full Level 1 LEI record for a legal entity. Returns legal name, registered address, headquarters address, entity category, legal form, registration authority, LEI registration status (ISSUED / LAPSED / RETIRED / ...), jurisdiction, parent LEI (if any), and timestamps. ' +
      'Accepts a company NAME as well as a 20-character LEI — a name is resolved against the registry here and the match is echoed back as resolved_from_name. Answers "is this company\'s LEI still active or has it lapsed" and "where is this entity registered".',
    summary: 'One legal entity\'s registration record by its LEI code, from the Global LEI Foundation.',
    inputSchema: {
      type: 'object',
      properties: {
        lei: { type: 'string', description: '20-character LEI code (e.g. "HWUPKR0MPOU8FGXBT394") OR the company NAME (e.g. "Wirecard AG") — a name is resolved here automatically and the match is echoed back as resolved_from_name. Pass the name whenever that is what you were given; do not construct an LEI. A guessed 20-character code that happens to exist belongs to SOME OTHER COMPANY, and the record comes back looking perfectly valid — asking about Wirecard AG with a made-up code returned Baader Bank\'s registration, with nothing in the response to show it was the wrong entity.' },
      },
      required: ['lei'],
    },
  },
  {
    name: 'get_lei_relationships',
    description:
      'Fetch Level 2 corporate hierarchy for an LEI: direct parent, ultimate parent, and direct children. Use to map ownership trees across multinational groups. Accepts a company NAME as well as an LEI.',
    summary: 'A legal entity\'s parent and subsidiary relationships, by LEI, from the Global LEI Foundation.',
    inputSchema: {
      type: 'object',
      properties: {
        lei: { type: 'string', description: '20-character LEI code (e.g. "HWUPKR0MPOU8FGXBT394") OR the company NAME (e.g. "Apple Inc") \u2014 a name is resolved here automatically and the match is echoed back as resolved_from_name. Do not guess an LEI: a wrong-but-well-formed code used to return an empty hierarchy, which reads as "this company has no parent or subsidiaries" rather than as an error.' },
      },
      required: ['lei'],
    },
  },
  {
    name: 'isin_to_lei',
    description:
      'Resolve an ISIN (12-character international securities identifier, e.g. "CH0038863350" or "DE0007164600") to the LEGAL ENTITY that issued the security: its LEI, registered legal name, jurisdiction, and status, via the official GLEIF ISIN-to-LEI mapping. Answers "who issued this security" / "which company is behind ISIN X" for non-US as well as US securities. An ISIN identifies one security while the issuer typically has many — the response says what it resolved TO. A valid ISIN with no mapping yet is reported as unmapped (the mapping lags new issuance), distinct from an invalid ISIN.',
    summary: 'The LEI code(s) mapped to a security\'s ISIN, from the Global LEI Foundation.',
    inputSchema: {
      type: 'object',
      properties: {
        isin: { type: 'string', description: '12-character ISIN, e.g. "CH0038863350" (2-letter country prefix + 9-char NSIN + check digit)' },
      },
      required: ['isin'],
    },
  },
  {
    name: 'lei_to_isins',
    description:
      'List ALL ISINs (securities) issued by a legal entity, from the official GLEIF ISIN-to-LEI mapping. Accepts a 20-character LEI or a company NAME (resolved automatically and echoed back). Answers "what securities has this company issued" / "all ISINs for Nestlé". Returns the full set — bonds, share lines, ADRs — not a single value; an entity that exists but has no mapped ISINs returns an empty set with that stated.',
    summary: 'The security ISINs mapped to a legal entity\'s LEI, from the Global LEI Foundation.',
    inputSchema: {
      type: 'object',
      properties: {
        lei: { type: 'string', description: '20-character LEI code (e.g. "KY37LUS27QQX7BB93L28") OR a company name (e.g. "Nestlé") — names are resolved via the LEI registry first.' },
      },
      required: ['lei'],
    },
  },
  {
    name: 'bic_to_lei',
    description:
      'Resolve a SWIFT/BIC bank identifier code (8 or 11 characters, e.g. "DEUTDEFF" or "DEUTDEFFXXX") to the bank\'s legal entity: LEI, registered legal name, jurisdiction, and status, via the official GLEIF BIC-to-LEI mapping. Answers "which legal entity is behind this BIC" / "LEI for SWIFT code X" for cross-border bank identity (KYC, counterparty due diligence, payments). A branch BIC that has no mapping of its own falls back to the head office (the trailing "XXX" form) and says so.',
    summary: 'The LEI code mapped to a bank\'s BIC/SWIFT code, from the Global LEI Foundation.',
    inputSchema: {
      type: 'object',
      properties: {
        bic: { type: 'string', description: 'SWIFT/BIC code, 8 or 11 characters, e.g. "DEUTDEFF", "CHASUS33" or "DEUTDEFFXXX". 8-character codes are treated as the head office ("XXX" branch).' },
      },
      required: ['bic'],
    },
  },
  {
    name: 'lei_hierarchy_tree',
    description:
      'Walk the FULL corporate ownership hierarchy for an entity in one call: the ancestor chain from the entity up to its ultimate parent, plus a multi-level tree of subsidiaries below it (breadth-first over GLEIF Level 2 direct-child records, depth-limited, depth stated in the response). Accepts a 20-character LEI or a company NAME. Answers "everything this group ultimately controls" / "full subsidiary tree of Deutsche Bank" / "who is at the top of this entity\'s ownership chain" — use get_lei_relationships instead when one hop (direct parent + direct children) is enough.',
    summary: 'A legal entity\'s full parent/subsidiary hierarchy tree, by LEI, from the Global LEI Foundation.',
    inputSchema: {
      type: 'object',
      properties: {
        lei: { type: 'string', description: '20-character LEI code OR a company name (resolved automatically, match echoed back).' },
        depth: { type: 'number', description: 'How many generations of subsidiaries to descend: 1-4, default 2. The ancestor chain upward is always walked to the top regardless.' },
      },
      required: ['lei'],
    },
  },
];

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing or empty. Pass a string like ${example}.`);
  }
  return v;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_lei':
      return searchLei(
        reqStr(args, 'query', '"Apple Inc" or "Vodafone"'),
        args.country as string | undefined,
        args.status as string | undefined,
        (args.page_size as number) ?? 25,
      );
    case 'get_lei':
      return getLei(reqStr(args, 'lei', '"HWUPKR0MPOU8FGXBT394" (20-char ISO 17442) or a company name like "Wirecard AG"'));
    case 'get_lei_relationships':
      return getRelationships(reqStr(args, 'lei', '"HWUPKR0MPOU8FGXBT394" (20-char ISO 17442)'));
    case 'isin_to_lei':
      return isinToLei(reqStr(args, 'isin', '"CH0038863350" (12-char ISO 6166)'));
    case 'lei_to_isins':
      return leiToIsins(reqStr(args, 'lei', '"KY37LUS27QQX7BB93L28" or a company name'));
    case 'bic_to_lei':
      return bicToLei(reqStr(args, 'bic', '"DEUTDEFF" or "DEUTDEFFXXX" (SWIFT/BIC)'));
    case 'lei_hierarchy_tree':
      return hierarchyTree(
        reqStr(args, 'lei', '"7LTWFZYICNSX8D621K86" or a company name'),
        args.depth as number | undefined,
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function gleifFetch(path: string): Promise<unknown> {
  const res = await pwFetch(`${BASE_URL}${path}`, {
    headers: { Accept: 'application/vnd.api+json' },
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 404) throw new Error(`GLEIF: not found (${body.slice(0, 120)})`);
    throw new Error(`GLEIF error: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

interface LeiRecord {
  id: string;
  attributes?: {
    lei?: string;
    entity?: {
      legalName?: { name?: string };
      otherNames?: { name?: string }[];
      legalAddress?: { addressLines?: string[]; city?: string; region?: string; country?: string; postalCode?: string };
      headquartersAddress?: { addressLines?: string[]; city?: string; region?: string; country?: string; postalCode?: string };
      jurisdiction?: string;
      category?: string;
      legalForm?: { id?: string; other?: string };
      status?: string;
    };
    registration?: {
      status?: string;
      initialRegistrationDate?: string;
      lastUpdateDate?: string;
      nextRenewalDate?: string;
      managingLou?: string;
    };
    bic?: string[];
    isins?: string[];
  };
  relationships?: {
    'direct-parent'?: { links?: { related?: string } };
    'ultimate-parent'?: { links?: { related?: string } };
    'direct-children'?: { links?: { related?: string } };
  };
}

function normalizeRecord(r: LeiRecord) {
  const a = r.attributes ?? {};
  const e = a.entity ?? {};
  return {
    lei: a.lei ?? r.id,
    legal_name: e.legalName?.name ?? null,
    other_names: (e.otherNames ?? []).map((n) => n.name).filter(Boolean),
    jurisdiction: e.jurisdiction ?? null,
    category: e.category ?? null,
    legal_form: e.legalForm?.id ?? e.legalForm?.other ?? null,
    entity_status: e.status ?? null,
    registration_status: a.registration?.status ?? null,
    initial_registration: a.registration?.initialRegistrationDate ?? null,
    last_update: a.registration?.lastUpdateDate ?? null,
    next_renewal: a.registration?.nextRenewalDate ?? null,
    managing_lou: a.registration?.managingLou ?? null,
    legal_address: fmtAddress(e.legalAddress),
    headquarters_address: fmtAddress(e.headquartersAddress),
    bic: a.bic ?? [],
    isins: a.isins ?? [],
    gleif_url: `https://search.gleif.org/#/record/${a.lei ?? r.id}`,
  };
}

function fmtAddress(a?: { addressLines?: string[]; city?: string; region?: string; country?: string; postalCode?: string }) {
  if (!a) return null;
  return {
    lines: a.addressLines ?? [],
    city: a.city ?? null,
    region: a.region ?? null,
    country: a.country ?? null,
    postal_code: a.postalCode ?? null,
  };
}

/** Legal-form designators. GLEIF matches whole tokens, so "Corp" never matches
 *  "CORPORATION" and the whole search comes back empty. Dropping these rescues the
 *  query without changing which company the caller meant. */
const LEGAL_FORM_TOKENS = new Set([
  'inc', 'inc.', 'incorporated', 'corp', 'corp.', 'corporation', 'co', 'co.', 'company',
  'ltd', 'ltd.', 'limited', 'llc', 'l.l.c.', 'llp', 'lp', 'plc', 'p.l.c.', 'pc',
  'ag', 'gmbh', 'kgaa', 'kg', 'mbh', 'se', 'ab', 'as', 'a/s', 'asa', 'oy', 'oyj', 'aps',
  'sa', 's.a.', 'sas', 'sarl', 's.a.r.l.', 'spa', 's.p.a.', 'srl', 's.r.l.', 'nv', 'n.v.',
  'bv', 'b.v.', 'kk', 'k.k.', 'pte', 'pty', 'aktiengesellschaft', 'aktiebolag',
  'the', 'and', '&',
]);

/** Common alpha-3 codes and country names an LLM will hand us. GLEIF's country filter
 *  takes alpha-2 only and answers 200-with-zero-rows for anything else — a silent lie. */
const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'US', us: 'US', 'united states': 'US', 'united states of america': 'US', america: 'US',
  gbr: 'GB', uk: 'GB', 'united kingdom': 'GB', britain: 'GB', 'great britain': 'GB', england: 'GB',
  deu: 'DE', ger: 'DE', germany: 'DE', fra: 'FR', france: 'FR', ita: 'IT', italy: 'IT',
  esp: 'ES', spain: 'ES', nld: 'NL', netherlands: 'NL', holland: 'NL', che: 'CH', switzerland: 'CH',
  swe: 'SE', sweden: 'SE', nor: 'NO', norway: 'NO', dnk: 'DK', denmark: 'DK', fin: 'FI', finland: 'FI',
  irl: 'IE', ireland: 'IE', bel: 'BE', belgium: 'BE', aut: 'AT', austria: 'AT', pol: 'PL', poland: 'PL',
  prt: 'PT', portugal: 'PT', lux: 'LU', luxembourg: 'LU', grc: 'GR', greece: 'GR',
  jpn: 'JP', japan: 'JP', chn: 'CN', china: 'CN', hkg: 'HK', 'hong kong': 'HK',
  kor: 'KR', 'south korea': 'KR', korea: 'KR', ind: 'IN', india: 'IN', sgp: 'SG', singapore: 'SG',
  aus: 'AU', australia: 'AU', nzl: 'NZ', 'new zealand': 'NZ', can: 'CA', canada: 'CA',
  mex: 'MX', mexico: 'MX', bra: 'BR', brazil: 'BR', arg: 'AR', argentina: 'AR', chl: 'CL', chile: 'CL',
  zaf: 'ZA', 'south africa': 'ZA', are: 'AE', uae: 'AE', sau: 'SA', 'saudi arabia': 'SA',
  isr: 'IL', israel: 'IL', tur: 'TR', turkey: 'TR', rus: 'RU', russia: 'RU', twn: 'TW', taiwan: 'TW',
  cym: 'KY', 'cayman islands': 'KY', jey: 'JE', jersey: 'JE', bmu: 'BM', bermuda: 'BM',
};

const ENTITY_STATUSES = new Set(['ACTIVE', 'INACTIVE', 'NULL']);
const REGISTRATION_STATUSES = new Set([
  'ISSUED', 'LAPSED', 'ANNULLED', 'PENDING_TRANSFER', 'PENDING_ARCHIVAL', 'DUPLICATE', 'RETIRED', 'MERGED',
]);

function normalizeCountry(raw: string): string {
  const t = raw.trim();
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  const mapped = COUNTRY_ALIASES[t.toLowerCase()];
  if (mapped) return mapped;
  throw new Error(
    `GLEIF: country "${raw}" is not an ISO 3166-1 alpha-2 code. GLEIF's country filter accepts alpha-2 only ` +
      `and returns zero rows for anything else, so this is rejected rather than answered with a misleading empty result. ` +
      `Pass e.g. "US", "DE", "JP".`,
  );
}

/** GLEIF splits status across two fields; sending a registration value to the entity
 *  field is a hard 400 (LAPSED/PENDING used to error out every time). */
function statusFilter(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (ENTITY_STATUSES.has(s)) return `filter[entity.status]=${encodeURIComponent(s)}`;
  if (REGISTRATION_STATUSES.has(s)) return `filter[registration.status]=${encodeURIComponent(s)}`;
  if (s === 'PENDING') {
    throw new Error(
      'GLEIF: "PENDING" is ambiguous. Use PENDING_TRANSFER or PENDING_ARCHIVAL (LEI registration status).',
    );
  }
  throw new Error(
    `GLEIF: unknown status "${raw}". Entity status: ACTIVE, INACTIVE, NULL. ` +
      `Registration status: ISSUED, LAPSED, ANNULLED, PENDING_TRANSFER, PENDING_ARCHIVAL, DUPLICATE, RETIRED, MERGED.`,
  );
}

/** "The Procter and Gamble Company" -> "Procter Gamble"; "Microsoft Corp" -> "Microsoft". */
function stripLegalForm(query: string): string {
  const kept = query
    .split(/\s+/)
    .filter((t) => t && !LEGAL_FORM_TOKENS.has(t.toLowerCase()));
  return kept.length ? kept.join(' ') : query;
}

/** Registries often hold the run-together spelling: "Exxon Mobil" -> "ExxonMobil". */
function joinWords(query: string): string {
  return query.split(/\s+/).filter(Boolean).join('');
}

/**
 * Legal-form spellings that two authorities disagree about (fleet #367).
 *
 * EDGAR abbreviates the legal form, GLEIF registers it in full: EDGAR says
 * MICROSOFT CORP, GLEIF says MICROSOFT CORPORATION. The exact-name guard then
 * correctly refuses to bridge them, so querying by TICKER — the most common way
 * anyone names a company — returned no LEI for most large caps, while querying
 * by full legal name worked.
 *
 * This is a CLOSED EQUIVALENCE TABLE, not similarity scoring. Each pair is a
 * known orthographic difference between two registries for the SAME legal form.
 * Nothing here lowers a threshold, and the exact comparison stays exact: if the
 * normalized strings still differ, the resolver refuses exactly as before.
 *
 * That distinction is the whole point of the guard. GLEIF's top relaxed match
 * for "Toyota Motor Corp" is "TOYOTA MOTOR CORPORATION ADRHEDGED", an unrelated
 * ETF wrapper — normalizing CORPORATION to CORP leaves "toyota motor corp"
 * against "toyota motor corp adrhedged", still unequal, still refused. A
 * similarity threshold loose enough to bridge the legal form would also bridge
 * that, and every downstream join would be quietly wrong.
 */
const LEGAL_FORM_CANONICAL: Record<string, string> = {
  corporation: 'corp',
  incorporated: 'inc',
  company: 'co',
  limited: 'ltd',
  // Already short, listed so the table is the single place to look.
  corp: 'corp',
  inc: 'inc',
  co: 'co',
  ltd: 'ltd',
  plc: 'plc',
  lp: 'lp',
  llc: 'llc',
  llp: 'llp',
  nv: 'nv',
  sa: 'sa',
  ag: 'ag',
  se: 'se',
  gmbh: 'gmbh',
  ab: 'ab',
  as: 'as',
  oy: 'oy',
};

/**
 * Punctuated forms that collapse into separate letters once punctuation is
 * stripped: "N.V." becomes "n v", which no longer equals GLEIF's "NV". Rejoined
 * before the table is applied. Only forms whose letters are meaningless as
 * standalone tokens are listed, so nothing real is glued together.
 */
const SPACED_LEGAL_FORMS: [RegExp, string][] = [
  [/\bp l c\b/g, 'plc'],
  [/\bl l c\b/g, 'llc'],
  [/\bl l p\b/g, 'llp'],
  [/\bn v\b/g, 'nv'],
  [/\bs a\b/g, 'sa'],
  [/\ba g\b/g, 'ag'],
  [/\bl p\b/g, 'lp'],
];

export function normName(s: string): string {
  let out = s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const [re, to] of SPACED_LEGAL_FORMS) out = out.replace(re, to);
  return out
    .split(' ')
    .map((t) => LEGAL_FORM_CANONICAL[t] ?? t)
    .join(' ')
    .trim();
}

async function nameQuery(
  name: string,
  extra: string[],
  pageSize: number,
): Promise<{ rows: LeiRecord[]; total: number }> {
  const parts = [`filter[entity.legalName]=${encodeURIComponent(name)}`, `page[size]=${pageSize}`, ...extra];
  const data = (await gleifFetch(`/lei-records?${parts.join('&')}`)) as {
    data?: LeiRecord[];
    meta?: { pagination?: { total?: number } };
  };
  return { rows: data.data ?? [], total: data.meta?.pagination?.total ?? 0 };
}

/** GLEIF's autocomplete index. Returns bare name strings + the LEI they belong to,
 *  which we then hydrate through the normal record endpoint. Last resort only —
 *  it is edit-distance based, so short queries come back as noise. */
async function fuzzyLeis(query: string, limit: number): Promise<string[]> {
  const data = (await gleifFetch(
    `/fuzzycompletions?field=entity.legalName&q=${encodeURIComponent(query)}&page[size]=${limit}`,
  )) as { data?: { relationships?: { 'lei-records'?: { data?: { id?: string } } } }[] };
  const ids: string[] = [];
  for (const r of data.data ?? []) {
    const id = r.relationships?.['lei-records']?.data?.id;
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

async function searchLei(query: string, country?: string, status?: string, pageSize = 25) {
  // URLSearchParams encodes '[' and ']' as '%5B'/'%5D', which breaks GLEIF's JSON:API
  // filter syntax — the server treats the parameter name as a literal string and ignores
  // the filter, returning the entire 2.5M-record dataset unfiltered. Build the query string
  // manually to keep brackets unencoded.
  const ps = Math.min(200, Math.max(1, pageSize));
  const extra: string[] = [];
  if (country) extra.push(`filter[entity.legalAddress.country]=${encodeURIComponent(normalizeCountry(country))}`);
  if (status) extra.push(statusFilter(status));

  // The three-stage name ladder, as a closure so it can be re-run with a different
  // filter set (see the country fallback below) without recursing into searchLei.
  const ladder = async (filters: string[]) => {
  const searchedAs: string[] = [];
  let matchMode: 'legal_name' | 'legal_name_relaxed' | 'fuzzy' | 'none' = 'none';
  let rows: LeiRecord[] = [];
  // How many records GLEIF says match the query that produced `rows` — only
  // meaningful when a single query produced them.
  let totalMatching: number | null = null;

  // 1. The name exactly as asked. GLEIF matches whole tokens against the registered
  //    legal name, so this is right whenever the caller used the registered wording.
  searchedAs.push(query);
  const first = await nameQuery(query, filters, ps);
  if (first.rows.length) {
    rows = first.rows;
    totalMatching = first.total;
    matchMode = 'legal_name';
  }

  // 2. Zero rows almost always means a token that isn't literally in the registered
  //    name — an abbreviated legal form ("Corp" vs "CORPORATION") or a space the
  //    registry doesn't have ("Exxon Mobil" vs "EXXONMOBIL"). Retry both shapes.
  if (!rows.length) {
    const variants: string[] = [];
    const stripped = stripLegalForm(query);
    if (normName(stripped) !== normName(query)) variants.push(stripped);
    const joined = joinWords(stripped);
    if (joined !== stripped && joined.length > 2) variants.push(joined);

    if (variants.length) {
      const settled = await Promise.all(
        variants.map((v) => nameQuery(v, filters, ps).catch(() => ({ rows: [] as LeiRecord[], total: 0 }))),
      );
      const seen = new Set<string>();
      const merged: LeiRecord[] = [];
      let hitCount = 0;
      let lastTotal = 0;
      settled.forEach((batch, i) => {
        if (batch.rows.length) {
          searchedAs.push(variants[i]);
          hitCount += 1;
          lastTotal = batch.total;
        }
        for (const r of batch.rows) {
          const key = r.attributes?.lei ?? r.id;
          if (key && !seen.has(key)) {
            seen.add(key);
            merged.push(r);
          }
        }
      });
      if (merged.length) {
        rows = merged.slice(0, ps);
        matchMode = 'legal_name_relaxed';
        totalMatching = hitCount === 1 ? lastTotal : null;
      }
    }
  }

  // 3. Still nothing — hand it to GLEIF's fuzzy autocomplete and hydrate the hits.
  if (!rows.length) {
    const ids = await fuzzyLeis(query, Math.min(20, ps)).catch(() => [] as string[]);
    if (ids.length) {
      // Re-apply the caller's country/status filters — the fuzzy index ignores them,
      // and handing back an out-of-scope entity would quietly answer a different question.
      const hydrateParts = [
        `filter[lei]=${ids.map(encodeURIComponent).join(',')}`,
        `page[size]=${ps}`,
        ...filters,
      ];
      const hydrated = (await gleifFetch(`/lei-records?${hydrateParts.join('&')}`).catch(() => ({}))) as {
        data?: LeiRecord[];
      };
      const got = hydrated.data ?? [];
      if (got.length) {
        rows = got;
        matchMode = 'fuzzy';
        searchedAs.push(`fuzzy:${query}`);
      }
    }
  }

    return { rows, matchMode, searchedAs, totalMatching };
  };

  let attempt = await ladder(extra);
  let countryDropped: string | null = null;

  // A country that is correct in the world can still be empty in the registry. GLEIF
  // filters on the country of the REGISTERED LEGAL ADDRESS, and e.g. no Sberbank-named
  // record has a Russian one (they sit in CY / SK / LU / GB), so
  // filter[entity.legalAddress.country]=RU returns "total": 0 for a company that is
  // plainly in GLEIF. Zero rows then reads as "this entity is not registered anywhere",
  // which is a wrong answer produced by a narrowing argument the caller volunteered.
  // Drop the filter, keep the rows, and say what happened.
  if (!attempt.rows.length && country) {
    const wider = await ladder(extra.filter((f) => !f.startsWith('filter[entity.legalAddress.country]')));
    if (wider.rows.length) {
      attempt = wider;
      countryDropped = normalizeCountry(country);
    }
  }

  const { rows, matchMode, searchedAs, totalMatching } = attempt;
  const results = rows.map(normalizeRecord);

  // Rank the page so the entity the caller actually named isn't buried behind
  // unrelated companies that happen to share a token ("APPLE FABRICS" before "Apple Inc.").
  const wanted = normName(query);
  const score = (r: { legal_name: string | null }) => {
    const n = normName(r.legal_name ?? '');
    if (!n) return 3;
    if (n === wanted) return 0;
    if (n.startsWith(wanted)) return 1;
    return 2;
  };
  results.sort((a, b) => score(a) - score(b));

  const exact = results.find((r) => normName(r.legal_name ?? '') === wanted) ?? null;

  const notes: string[] = [];
  if (countryDropped) {
    notes.push(
      `No GLEIF record matching "${query}" has a legal address in ${countryDropped}, so that filter ` +
        `was dropped and these are the unrestricted matches. GLEIF stores the country of the ` +
        `REGISTERED legal address, which is often not where the entity operates — read ` +
        `legal_address and jurisdiction on each result before treating one as the entity you meant.`,
    );
  }
  if (matchMode === 'legal_name_relaxed' || matchMode === 'fuzzy') {
    notes.push(
      `No LEI record's legal name contains every word of "${query}". ` +
        (matchMode === 'fuzzy'
          ? `These are GLEIF fuzzy-autocomplete matches and may not be the entity you meant.`
          : `Results below are for ${searchedAs.slice(1).map((s) => `"${s}"`).join(' / ')} — verify the legal name before using the LEI.`),
    );
  }

  return {
    found: results.length > 0,
    query,
    // Which query string actually produced these rows — the caller's, a relaxed
    // rewrite, or GLEIF's fuzzy index. Never silently pretend we ran what was asked.
    match_mode: matchMode,
    searched_as: searchedAs,
    ...(notes.length ? { note: notes.join(' ') } : {}),
    // Named so a caller can see the narrowing argument it supplied was not honoured.
    ...(countryDropped ? { country_filter_dropped: countryDropped } : {}),
    returned: results.length,
    // How many records GLEIF says match the query that produced these rows. Null when
    // the rows came from merging several rewrites or from the fuzzy index, where a
    // single "total" would be a fiction.
    total: totalMatching,
    exact_legal_name_match: exact ? { lei: exact.lei, legal_name: exact.legal_name } : null,
    results,
  };
}

// Accepts a NAME as well as an LEI, like its four siblings. It was the only tool in the
// pack that did not, and the asymmetry cost us a silent wrong answer: a router reading
// four name-taking tools assumed the fifth took names too, then — rather than passing
// the name — supplied a 20-character code it made up. The code was a real LEI belonging
// to a different German bank, so GLEIF answered with a valid record for the wrong company
// and nothing downstream could tell.
async function getLei(rawLei: string) {
  const { lei, resolved } = await resolveLei(rawLei);
  const data = (await gleifFetch(`/lei-records/${encodeURIComponent(lei)}`)) as { data?: LeiRecord };
  if (!data.data) throw new Error(`GLEIF: no record for LEI ${lei}`);
  return {
    ...normalizeRecord(data.data),
    ...(resolved ? { resolved_from_name: resolved } : {}),
  };
}

const LEI_SHAPE = /^[A-Z0-9]{20}$/i;

/** ISO 17442 check digits (ISO 7064 MOD 97-10): map A-Z to 10-35 across the whole
 *  20-character code and the result must be congruent to 1 mod 97. Every issued LEI
 *  satisfies this; an invented one satisfies it about 1 time in 97. Without the check a
 *  fabricated code is indistinguishable from a real one until GLEIF answers — and the
 *  dangerous case is precisely when GLEIF DOES answer, because then the caller gets a
 *  well-formed record for a company they never asked about. */
function leiChecksumOk(lei: string): boolean {
  let rem = 0;
  for (const ch of lei.toUpperCase()) {
    const v = parseInt(ch, 36);
    if (Number.isNaN(v)) return false;
    rem = (rem * (v > 9 ? 100 : 10) + v) % 97;
  }
  return rem === 1;
}

// Accept a company NAME as well as an LEI. Nobody has a 20-character LEI to
// hand, so a model asked for corporate hierarchy will invent one or pass the
// name — and the name went straight into the URL path, where GLEIF 404s it and
// the .catch(() => null) below turned that into "no relationships".
async function resolveLei(value: string): Promise<{ lei: string; resolved?: Record<string, unknown> }> {
  const v = value.trim();
  if (LEI_SHAPE.test(v)) {
    if (!leiChecksumOk(v)) {
      throw new Error(
        `user_error: "${v}" is 20 characters but its ISO 17442 check digits do not validate, so it is not ` +
          `an issued LEI. Pass the company NAME instead — it is resolved automatically here — or call gleif ` +
          `search_lei to find the LEI. Do not construct an LEI code: one that happens to exist belongs to a ` +
          `different company and its record comes back looking entirely valid.`,
      );
    }
    return { lei: v.toUpperCase() };
  }
  const found = (await searchLei(v, undefined, undefined, 10)) as {
    results?: { lei?: string; legal_name?: string; entity_status?: string }[];
    match_mode?: string;
  };
  const items = found.results ?? [];
  // searchLei already ranks exact legal-name matches first; prefer an ACTIVE
  // entity among them, since a dissolved namesake is the likeliest wrong pick.
  const best = items.find((r) => r.entity_status === 'ACTIVE') ?? items[0];
  if (!best?.lei) {
    throw new Error(`user_error: No LEI record matches "${v}". Use gleif search_lei to see candidates.`);
  }
  return {
    lei: best.lei,
    resolved: {
      resolved_from: v,
      lei: best.lei,
      legal_name: best.legal_name ?? null,
      entity_status: best.entity_status ?? null,
      // match_mode carries searchLei's own honesty about whether this was an
      // exact legal-name hit or a fuzzy guess. A caller acting on a hierarchy
      // needs to see that, not just the LEI it landed on.
      match_mode: found.match_mode ?? null,
    },
  };
}

// Only called when the answer would otherwise be "no relationships at all".
// A 404 on /direct-parent legitimately means "this entity has no parent", which
// is why the fetches below swallow errors — but that same swallow also hid "no
// such LEI". This separates them. Non-404 failures are deliberately ignored so
// a transient never becomes a false "does not exist".
async function assertLeiExists(lei: string): Promise<void> {
  try {
    await gleifFetch(`/lei-records/${encodeURIComponent(lei)}`);
  } catch (e) {
    if (/not found/i.test((e as Error).message)) {
      throw new Error(
        `user_error: No GLEIF record exists for LEI "${lei}", so it has no hierarchy to report. `
        + 'If you guessed this code, pass the company NAME instead and it will be resolved, '
        + 'or use gleif search_lei to find the right LEI.',
      );
    }
  }
}

async function getRelationships(rawLei: string) {
  const { lei, resolved } = await resolveLei(rawLei);
  // GLEIF exposes related-records endpoints under /lei-records/{lei}/{relationship}
  const [direct, ultimate, children] = await Promise.all([
    gleifFetch(`/lei-records/${encodeURIComponent(lei)}/direct-parent`).catch(() => null),
    gleifFetch(`/lei-records/${encodeURIComponent(lei)}/ultimate-parent`).catch(() => null),
    gleifFetch(`/lei-records/${encodeURIComponent(lei)}/direct-children?page[size]=200`).catch(() => null),
  ]);

  const normalizeOne = (resp: unknown) => {
    if (!resp) return null;
    const r = (resp as { data?: LeiRecord }).data;
    return r ? normalizeRecord(r) : null;
  };
  const normalizeMany = (resp: unknown) => {
    if (!resp) return [];
    const arr = (resp as { data?: LeiRecord[] }).data ?? [];
    return arr.map(normalizeRecord);
  };

  const direct_parent = normalizeOne(direct);
  const ultimate_parent = normalizeOne(ultimate);
  const direct_children = normalizeMany(children);

  // Nothing at all came back. That is a real and common answer — a standalone
  // company has no parent and no children — so it must NOT become an error on
  // its own. But it is also exactly what a nonexistent LEI produces, and those
  // two were indistinguishable. Check which one this is.
  if (!direct_parent && !ultimate_parent && direct_children.length === 0) {
    await assertLeiExists(lei);
  }

  return {
    lei,
    ...(resolved ? { resolved_from_name: resolved } : {}),
    direct_parent,
    ultimate_parent,
    direct_children,
  };
}

// ── ISIN / BIC mapping + hierarchy tree ─────────────────────────────

const ISIN_SHAPE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/** ISO 6166 check digit — letters expand to two digits (A=10 … Z=35), then Luhn
 *  over the digit string including the check digit. Separates "not an ISIN"
 *  from "an ISIN GLEIF hasn't mapped", which the acceptance of both answers
 *  depends on: an invalid code is a caller mistake, an unmapped one is a fact. */
function isinChecksumOk(isin: string): boolean {
  const digits: number[] = [];
  for (const ch of isin) {
    const v = parseInt(ch, 36); // '0'-'9' -> 0-9, 'A'-'Z' -> 10-35
    if (v >= 10) {
      digits.push(Math.floor(v / 10), v % 10);
    } else {
      digits.push(v);
    }
  }
  let sum = 0;
  let dbl = false; // rightmost digit (the check digit itself) is NOT doubled
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits[i];
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

async function isinToLei(rawIsin: string) {
  const isin = rawIsin.trim().toUpperCase();
  if (!ISIN_SHAPE.test(isin)) {
    throw new Error(
      `user_error: "${rawIsin}" is not ISIN-shaped. An ISIN is 12 characters: 2-letter country prefix + 9-character NSIN + 1 check digit, e.g. "CH0038863350".`,
    );
  }
  if (!isinChecksumOk(isin)) {
    throw new Error(
      `user_error: "${isin}" fails the ISIN check digit (ISO 6166 Luhn), so it is a typo or a made-up code — not merely unmapped. Verify the ISIN; the isin pack's validate_isin shows the expected check digit.`,
    );
  }
  const data = (await gleifFetch(`/lei-records?filter[isin]=${encodeURIComponent(isin)}&page[size]=15`)) as {
    data?: LeiRecord[];
  };
  const rows = (data.data ?? []).map(normalizeRecord);
  if (!rows.length) {
    return {
      found: false,
      mapped: false,
      isin,
      reason: 'isin_unmapped',
      hint:
        'This ISIN is structurally valid but has no entry in GLEIF\'s ISIN-to-LEI mapping. The mapping lags ' +
        'new issuance and covers issuers that hold an LEI, so a recent, sovereign, or exotic security may ' +
        'legitimately be unmapped — this is NOT evidence the security or issuer does not exist. ' +
        (isin.startsWith('US') ? `For US securities the embedded CUSIP is characters 3-11 ("${isin.slice(2, 11)}") — try openfigi_map with idType ID_CUSIP.` : 'Try openfigi_map with idType ID_ISIN for security-level metadata.'),
    };
  }
  // One ISIN maps to one issuing entity; the reverse is one-to-many
  // (reference-resolver-grain-traps) — say what was resolved TO.
  return {
    found: true,
    mapped: true,
    isin,
    resolved_to: 'issuing_legal_entity',
    note:
      'The LEI identifies the legal entity that ISSUED this security. One entity issues many securities — ' +
      'use lei_to_isins for the full set.',
    issuer: rows[0],
    ...(rows.length > 1 ? { additional_matches: rows.slice(1) } : {}),
  };
}

const ISINS_PAGE_SIZE = 200;
const ISINS_MAX_PAGES = 5; // 1,000 ISINs — beyond this, say truncated rather than hang

async function leiToIsins(rawLei: string) {
  const { lei, resolved } = await resolveLei(rawLei);
  const isins: string[] = [];
  let total = 0;
  let pages = 0;
  for (let page = 1; page <= ISINS_MAX_PAGES; page++) {
    const data = (await gleifFetch(
      `/lei-records/${encodeURIComponent(lei)}/isins?page[size]=${ISINS_PAGE_SIZE}&page[number]=${page}`,
    )) as {
      data?: { attributes?: { isin?: string } }[];
      meta?: { pagination?: { total?: number; lastPage?: number } };
    };
    pages = page;
    total = data.meta?.pagination?.total ?? total;
    for (const r of data.data ?? []) {
      if (r.attributes?.isin) isins.push(r.attributes.isin);
    }
    if (page >= (data.meta?.pagination?.lastPage ?? 1)) break;
  }
  if (!isins.length) {
    // Same ambiguity as an empty hierarchy: "no ISINs mapped" and "no such LEI"
    // both come back empty. assertLeiExists throws user_error on the latter.
    await assertLeiExists(lei);
    return {
      found: true,
      lei,
      ...(resolved ? { resolved_from_name: resolved } : {}),
      isin_count: 0,
      isins: [],
      note:
        'This entity exists in GLEIF but has no ISINs in the ISIN-to-LEI mapping — typical for private ' +
        'companies, funds without listed securities, or issuers whose securities predate the mapping.',
    };
  }
  return {
    found: true,
    lei,
    ...(resolved ? { resolved_from_name: resolved } : {}),
    isin_count: isins.length,
    total_mapped: total,
    truncated: total > isins.length,
    ...(total > isins.length
      ? { note: `Entity has ${total} mapped ISINs; first ${isins.length} returned.` }
      : {}),
    isins,
  };
}

const BIC_SHAPE = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

async function bicQuery(bic11: string): Promise<LeiRecord[]> {
  const data = (await gleifFetch(`/lei-records?filter[bic]=${encodeURIComponent(bic11)}&page[size]=15`)) as {
    data?: LeiRecord[];
  };
  return data.data ?? [];
}

async function bicToLei(rawBic: string) {
  const bic = rawBic.trim().toUpperCase().replace(/\s+/g, '');
  if (!BIC_SHAPE.test(bic)) {
    throw new Error(
      `user_error: "${rawBic}" is not a valid SWIFT/BIC shape. A BIC is 8 or 11 characters: 4-letter bank code + 2-letter country + 2-char location + optional 3-char branch, e.g. "DEUTDEFF" or "CHASUS33XXX".`,
    );
  }
  // GLEIF's filter matches the 11-character form only — a bare 8-char
  // head-office BIC returns zero rows until padded with the XXX branch.
  const asEleven = bic.length === 8 ? `${bic}XXX` : bic;
  let rows = await bicQuery(asEleven);
  let fellBackToHeadOffice = false;
  if (!rows.length && bic.length === 11 && !bic.endsWith('XXX')) {
    rows = await bicQuery(`${bic.slice(0, 8)}XXX`);
    fellBackToHeadOffice = rows.length > 0;
  }
  if (!rows.length) {
    return {
      found: false,
      mapped: false,
      bic,
      reason: 'bic_unmapped',
      hint:
        'This BIC has no entry in GLEIF\'s BIC-to-LEI mapping (neither the branch nor its head office). ' +
        'The mapping covers institutions that hold an LEI, so a small bank or a very new BIC may legitimately ' +
        'be unmapped — this is NOT evidence the BIC is invalid. Try search_lei with the bank\'s name.',
    };
  }
  return {
    found: true,
    mapped: true,
    bic,
    searched_as: fellBackToHeadOffice ? `${bic.slice(0, 8)}XXX` : asEleven,
    ...(fellBackToHeadOffice
      ? { note: `Branch BIC "${bic}" has no mapping of its own; resolved via its head office ("${bic.slice(0, 8)}XXX"). A branch is not a separate legal entity, so the head-office LEI is the legal identity behind it.` }
      : {}),
    resolved_to: 'legal_entity',
    entity: normalizeRecord(rows[0]),
    ...(rows.length > 1 ? { additional_matches: rows.slice(1).map(normalizeRecord) } : {}),
  };
}

const TREE_DEFAULT_DEPTH = 2;
const TREE_MAX_DEPTH = 4;
const TREE_MAX_NODES = 150; // total child-fetches per call — bounds subrequests
const TREE_MAX_ANCESTORS = 10;

interface TreeNode {
  lei: string;
  legal_name: string | null;
  country: string | null;
  entity_status: string | null;
  children?: TreeNode[];
  children_truncated?: boolean;
}

function toTreeNode(r: ReturnType<typeof normalizeRecord>): TreeNode {
  return {
    lei: r.lei,
    legal_name: r.legal_name,
    country: r.legal_address?.country ?? null,
    entity_status: r.entity_status,
  };
}

async function fetchChildren(lei: string): Promise<ReturnType<typeof normalizeRecord>[]> {
  const resp = (await gleifFetch(
    `/lei-records/${encodeURIComponent(lei)}/direct-children?page[size]=200`,
  ).catch(() => null)) as { data?: LeiRecord[] } | null;
  return (resp?.data ?? []).map(normalizeRecord);
}

async function hierarchyTree(rawLei: string, rawDepth?: number) {
  const depth = Math.min(TREE_MAX_DEPTH, Math.max(1, Math.round(rawDepth ?? TREE_DEFAULT_DEPTH)));
  const { lei, resolved } = await resolveLei(rawLei);

  const rootRecord = await getLei(lei); // throws user_error-ish "not found" for a bad LEI
  const root = toTreeNode(rootRecord);

  // Upward: follow direct-parent links to the top. GLEIF 404s /direct-parent
  // when there is no parent — that ends the walk, it is not an error.
  const ancestors: TreeNode[] = [];
  let cursor = lei;
  for (let hop = 0; hop < TREE_MAX_ANCESTORS; hop++) {
    const resp = (await gleifFetch(`/lei-records/${encodeURIComponent(cursor)}/direct-parent`).catch(() => null)) as
      | { data?: LeiRecord }
      | null;
    if (!resp?.data) break;
    const parent = toTreeNode(normalizeRecord(resp.data));
    if (ancestors.some((a) => a.lei === parent.lei) || parent.lei === lei) break; // cycle guard
    ancestors.push(parent);
    cursor = parent.lei;
  }
  const ultimateResp = (await gleifFetch(`/lei-records/${encodeURIComponent(lei)}/ultimate-parent`).catch(() => null)) as
    | { data?: LeiRecord }
    | null;
  const ultimate_parent = ultimateResp?.data ? toTreeNode(normalizeRecord(ultimateResp.data)) : null;

  // Downward: breadth-first, one generation at a time, whole level in parallel.
  let nodesFetched = 0;
  let truncated = false;
  let maxDepthReached = 0;
  let descendantCount = 0;
  let frontier: TreeNode[] = [root];
  for (let level = 1; level <= depth && frontier.length; level++) {
    const budget = TREE_MAX_NODES - nodesFetched;
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const toFetch = frontier.slice(0, budget);
    if (toFetch.length < frontier.length) truncated = true;
    nodesFetched += toFetch.length;
    const batches = await Promise.all(toFetch.map((n) => fetchChildren(n.lei)));
    const next: TreeNode[] = [];
    batches.forEach((batch, i) => {
      if (!batch.length) return;
      const kids = batch.map(toTreeNode);
      toFetch[i].children = kids;
      if (batch.length >= 200) toFetch[i].children_truncated = true;
      descendantCount += kids.length;
      next.push(...kids);
    });
    if (next.length) maxDepthReached = level;
    frontier = next;
  }
  const deeperExists = frontier.length > 0 && maxDepthReached === depth;

  return {
    lei,
    ...(resolved ? { resolved_from_name: resolved } : {}),
    depth_limit: depth,
    max_depth_allowed: TREE_MAX_DEPTH,
    depth_reached: maxDepthReached,
    descendants_returned: descendantCount,
    truncated,
    ...(deeperExists && depth < TREE_MAX_DEPTH
      ? { note: `Subsidiaries exist below depth ${depth}; call again with depth up to ${TREE_MAX_DEPTH} to descend further.` }
      : {}),
    ...(truncated
      ? { truncation_note: `Node budget (${TREE_MAX_NODES} entities per call) reached; some branches were not expanded. Walk the widest branch directly with get_lei_relationships.` }
      : {}),
    // Bottom-up chain from this entity to the top of its ownership chain —
    // ancestors[last] should equal ultimate_parent when GLEIF's records agree.
    ancestors,
    ultimate_parent,
    tree: root,
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
