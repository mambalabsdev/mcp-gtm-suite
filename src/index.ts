#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

const APIFY_TOKEN = process.env.APIFY_TOKEN;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Some actors validate their input schema as strings (Clay sends every field as
// a string), so booleans must be passed as "true"/"false" rather than raw bools.
function boolToString(v: boolean | undefined): string | undefined {
  return v === undefined ? undefined : v ? "true" : "false";
}

// How long the actor run itself is allowed to take, in seconds.
//
// MEASURED across the whole fleet, because this one caller fronts 21 actors
// and a per-actor number would be 21 constants that drift. Over every SUCCEEDED
// run in actor_runs on 2026-09-08, 5,088 of them carrying a duration: P95
// 38.5 s, P99 171.3 s, slowest ever 1,010.7 s.
//
// The suite was calling run-sync-get-dataset-items?timeout=300, so every tool
// it exposes was cut off at five minutes while the slowest run any of these
// actors has completed takes nearly seventeen. 1800 s is 1.8 times that slowest
// run and more than ten times the fleet P99, which is headroom for the slow
// tools without letting a hung run bill indefinitely.
//
// The standalone job discovery wrapper moved to start-and-poll first and the
// suite's copy of that tool did not, which is finding M-B4. This closes it for
// all 21.
const ACTOR_RUN_TIMEOUT_SECS = 1800;

// How long this wrapper waits for that run, in milliseconds. The actor's own
// timeout plus two minutes, so the run's own TIMED-OUT status is what the
// caller sees rather than the wrapper giving up first and reporting nothing.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = 3000;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// START AND POLL, NOT RUN-SYNC. This wrapper used
// run-sync-get-dataset-items?timeout=300 and cut off runs the actor completes:
// runs that the actors complete. Raising that query parameter does not fix it,
// which is worth stating
// because it is the obvious fix and it is wrong. Apify's synchronous endpoints
// carry a platform ceiling of 300 seconds on the HTTP wait itself and answer
// 408 past it regardless of what `timeout` says. The only way for the wrapper
// to wait as long as the actor needs is to start the run, poll it to a terminal
// status, and then read the dataset.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities instead of reporting none.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?timeout=${ACTOR_RUN_TIMEOUT_SECS}`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success. Surfacing it here is what keeps a crashed run from reading
  // as "no results found".
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message
      ? `${asObj.error.message}`
      : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-gtm-suite",
  version: pkg.version,
});

// 1. GTM Hiring Signal Scraper
server.registerTool(
  "scan_gtm_hiring_signals",
  {
    title: "Scan GTM Hiring Signals",
    description:
      "Scan company career pages to detect GTM hiring activity. Returns sales, marketing, and revenue operations job postings across Greenhouse, Lever, and Ashby as a flat, Clay-ready JSON row. Read-only; requires an APIFY_TOKEN and consumes Apify credits per call.",
    annotations: {
      title: "Scan GTM Hiring Signals",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
    domain: z.string().describe("Bare company domain, e.g. stripe.com"),
    role_filter: z
      .array(z.string())
      .optional()
      .describe("Optional list of GTM role keywords to filter on. Defaults to the built-in list."),
    ats_slug: z
      .string()
      .optional()
      .describe("Optional ATS board slug override when it differs from the domain."),
    mode: z
      .enum(["single", "batch", "velocity"])
      .optional()
      .describe("Processing mode. \"single\" scores the domain. \"velocity\" compares this run against previous_gtm_role_count and previous_run_date. \"batch\" is an actor-level mode this single-call tool supplies no list for. Default: \"single\"."),
    include_role_details: z
      .boolean()
      .optional()
      .describe("When true, include the full per-role detail array (title, department, location, url). Default: false."),
    previous_gtm_role_count: z
      .number()
      .int()
      .optional()
      .describe("GTM role count from the previous run for this domain, used in velocity mode to compute the delta."),
    previous_run_date: z
      .string()
      .optional()
      .describe("ISO date of the previous run for this domain, used in velocity mode to report days between runs."),
  },
  },
  async ({ domain, role_filter, ats_slug, mode, include_role_details, previous_gtm_role_count, previous_run_date }) =>
    runActor(
      "D7O1SA2EqwHGsGr1P",
      "GTM Hiring Signal Scraper",
      compact({ domain, role_filter, ats_slug, mode, include_role_details, previous_gtm_role_count, previous_run_date }),
    ),
);

// 2. GTM Tech Stack Signal Enrichment
server.registerTool(
  "detect_gtm_tech_stack",
  {
    title: "Detect GTM Tech Stack",
    description:
      "Detect which GTM tools a company uses from its public website. Returns CRM, sequencer, and marketing automation signals with per-tool boolean flags as a flat, Clay-ready JSON row. Read-only; requires an APIFY_TOKEN and consumes Apify credits per call.",
    annotations: {
      title: "Detect GTM Tech Stack",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
    domain: z
      .string()
      .optional()
      .describe("Bare company domain, e.g. stripe.com. Supply this, company_domain or url."),
    company_domain: z
      .string()
      .optional()
      .describe("Deprecated alias for domain, accepted by the actor for older callers. Prefer domain."),
    url: z
      .string()
      .optional()
      .describe("Deprecated alias for domain, accepted by the actor as a full company website URL. Prefer domain."),
    crawl_additional_pages: z
      .boolean()
      .optional()
      .describe("Crawl up to 2 extra pages for better coverage. Defaults to true when omitted."),
    skipCache: z
      .boolean()
      .optional()
      .describe("By default a clean detection is cached for 7 days and reused. Set true to force a fresh detection."),
  },
  },
  async ({ domain, company_domain, url, crawl_additional_pages, skipCache }) => {
    // Measured 2026-08-13: the actor's built schema marks nothing required, but
    // with no company named at all the run throws and exits FAILED. Rejecting
    // here rejects only what the actor itself rejects.
    if (domain === undefined && company_domain === undefined && url === undefined) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: "Provide domain, company_domain or url. The actor cannot run without one of them." }],
      };
    }
    return runActor(
      "qyd7nNyqFPelQViBx",
      "GTM Tech Stack Signal Enrichment",
      compact({ domain, company_domain, url, crawl_additional_pages, skipCache }),
    );
  },
);

// 3. GTM Signals Aggregator
server.registerTool(
  "aggregate_gtm_signals",
  {
    title: "Aggregate GTM Signals",
    description:
      "Aggregate a company's GTM signals into one composite score. Runs hiring and tech-stack detection in one call and returns a composite score, recommended action, and optional summary as a flat, Clay-ready JSON row. Read-only; requires an APIFY_TOKEN and consumes Apify credits per call.",
    annotations: {
      title: "Aggregate GTM Signals",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
    company_domain: z.string().describe("Bare company domain, e.g. stripe.com"),
    include_summary: z.boolean().optional().describe("Include a plain-English gtm_signal_summary."),
    explain_mode: z
      .boolean()
      .optional()
      .describe("If true, the summary becomes a longer, more detailed explanation."),
  },
  },
  async ({ company_domain, include_summary, explain_mode }) =>
    runActor(
      "xKdRfnfFNkdMpFuNs",
      "GTM Signals Aggregator",
      compact({ company_domain, include_summary, explain_mode }),
    ),
);

// 4. Job Board Keyword Signal Scanner
server.registerTool(
  "scan_job_board_keywords",
  {
    title: "Scan Job Board Keywords",
    description:
      "Scan a company's job board for roles in chosen categories across Greenhouse, Lever, Ashby, Workday, and Rippling. Returns matched role counts and titles per category as a flat, Clay-ready JSON row. Read-only; requires an APIFY_TOKEN and consumes Apify credits per call.",
    annotations: {
      title: "Scan Job Board Keywords",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
    company_domain: z.string().describe("Bare company domain, e.g. stripe.com"),
    role_categories: z
      .array(z.string())
      .describe("One or more of: GTM, Engineering, Finance, Operations, Executive, Custom."),
    custom_keywords: z
      .array(z.string())
      .optional()
      .describe("Keyword strings to match when Custom is included in role_categories."),
    enable_fallback: z
      .boolean()
      .optional()
      .describe("Fall back to a pre-indexed job database when the live ATS cascade finds nothing."),
    previous_roles_detected: z
      .string()
      .optional()
      .describe("Comma-separated matched role titles from a previous run, to compute deltas."),
    previous_run_date: z.string().optional().describe("ISO date of the previous run, e.g. 2026-03-15."),
  },
  },
  async ({
    company_domain,
    role_categories,
    custom_keywords,
    enable_fallback,
    previous_roles_detected,
    previous_run_date,
  }) =>
    runActor(
      "4DvqpvhMR74NLcDDY",
      "Job Board Keyword Signal Scanner",
      compact({
        company_domain,
        role_categories,
        custom_keywords,
        enable_fallback,
        previous_roles_detected,
        previous_run_date,
      }),
    ),
);

// 5. Domain to LinkedIn URL Resolver
server.registerTool(
  "resolve_linkedin_url",
  {
    title: "Resolve LinkedIn URL",
    description:
      "Resolve a company domain or name to its LinkedIn company URL with a confidence score, firmographics, and social links as a flat, Clay-ready JSON row. Provide at least one of company_domain or company_name. Read-only; requires an APIFY_TOKEN and consumes Apify credits per call.",
    annotations: {
      title: "Resolve LinkedIn URL",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
    company_domain: z
      .string()
      .optional()
      .describe("Bare company domain, e.g. stripe.com. Required if company_name is not provided."),
    company_name: z.string().optional().describe("Company name. Required if company_domain is not provided."),
    includeFirmographics: z
      .enum(["false", "true"])
      .optional()
      .describe("When \"true\", also fetches the public LinkedIn company page to add employee count, industry, HQ, follower count and description. Off by default because it is the most expensive step. Sent as a string for Clay compatibility."),
    skipCache: z
      .enum(["false", "true"])
      .optional()
      .describe("When \"false\", the default, a successful resolution is cached for 7 days and reused. Set \"true\" to force a fresh resolution. Sent as a string for Clay compatibility."),
  },
  },
  async ({ company_domain, company_name, includeFirmographics, skipCache }) => {
    if (
      (company_domain === undefined || company_domain === "") &&
      (company_name === undefined || company_name === "")
    ) {
      return {
        isError: true,
        content: [{ type: "text", text: "Provide at least one of company_domain or company_name." }],
      };
    }
    return runActor(
      "3HtnSaqPHOg1Qg5gx",
      "Domain to LinkedIn URL Resolver",
      compact({ company_domain, company_name, includeFirmographics, skipCache }),
    );
  },
);

// 6. ICP Fit Scorer (single-company scoring surface)
server.registerTool(
  "score_icp_fit",
  {
    title: "Score ICP Fit",
    description:
      "Score a company against your ideal customer profile (ICP) using weighted signals. Returns a 0 to 100 icp_score, an A to D icp_tier, and a per-signal breakdown as a flat, Clay-ready JSON row. Define your ICP with a template, scoring_config, or plain-English icp_description (which requires llm_api_key). Read-only; requires an APIFY_TOKEN and consumes Apify credits per call.",
    annotations: {
      title: "Score ICP Fit",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
    company_domain: z.string().describe("The primary domain of the company to score, e.g. clay.com"),
    company_name: z.string().optional().describe("Optional display name of the company."),
    template: z.string().optional().describe("Name of a prebuilt scoring config."),
    scoring_config: z.record(z.any()).optional().describe("JSON object of scoring weights."),
    icp_description: z
      .string()
      .optional()
      .describe("Plain-English ICP description. Requires llm_api_key."),
    llm_api_key: z.string().optional().describe("Your OpenAI or Anthropic key, used only with icp_description."),
    llm_provider: z.string().optional().describe("LLM provider for icp_description: openai or anthropic."),
    fetch_signals: z
      .boolean()
      .optional()
      .describe("If true, the actor fetches hiring and tech-stack signals automatically before scoring."),
    include_explanation: z
      .boolean()
      .optional()
      .describe("If true, adds a score_explanation string to the output."),
    tier_thresholds: z.record(z.any()).optional().describe("Optional. Minimum score for each tier as { \"tier_a\": number, \"tier_b\": number, \"tier_c\": number }. Scores at or above tier_a are A, tier_b are B, tier_c are C, else D. Defaults to 80 / 60 / 40."),
    funded_within_days: z.number().int().optional().describe("Optional. How recent a funding round must be to count for the recently_funded signal, in days. Defaults to 540 (18 months)."),
    min_score_to_output: z.number().int().optional().describe("If set, rows scoring below this threshold are skipped from output (not pushed to dataset). Skipped rows are logged only."),
    previous_score: z.number().int().optional().describe("Previous ICP score for this company. If provided, output includes score_change and score_trend fields."),
    gtm_hiring_signal: z.string().optional().describe("Whether the company is actively hiring for GTM/sales roles. Accepts a boolean-like string (\"true\"/\"false\"). Sent as a string for Clay compatibility and coerced to boolean at runtime."),
    gtm_role_count: z.string().optional().describe("Number of open GTM/sales roles. Scores via the gtm_role_count_strong signal when at or above min_gtm_roles (default 2). Accepts a numeric string (e.g. \"8\"). Sent as a string for Clay compatibility and coerced to integer at runtime."),
    uses_hubspot: z.string().optional().describe("Whether the company uses HubSpot. Accepts a boolean-like string (\"true\"/\"false\"). Sent as a string for Clay compatibility and coerced to boolean at runtime."),
    uses_salesforce: z.string().optional().describe("Whether the company uses Salesforce. Accepts a boolean-like string (\"true\"/\"false\"). Sent as a string for Clay compatibility and coerced to boolean at runtime."),
    uses_clay: z.string().optional().describe("Whether the company uses Clay. Accepts a boolean-like string (\"true\"/\"false\"). Sent as a string for Clay compatibility and coerced to boolean at runtime."),
    crm_detected: z.string().optional().describe("Whether any CRM was detected. Accepts a boolean-like string (\"true\"/\"false\") or any non-empty CRM name (e.g. \"Salesforce\"). Sent as a string for Clay compatibility and coerced to boolean at runtime. Auto-derived from uses_hubspot/uses_salesforce if not set."),
    seq_tool_detected: z.string().optional().describe("Whether a sales sequencing tool (Outreach, SalesLoft, Apollo, Lemlist) was detected. Accepts a boolean-like string (\"true\"/\"false\") or any non-empty tool name (e.g. \"Outreach\"). Sent as a string for Clay compatibility and coerced to boolean at runtime."),
    tech_stack: z.string().optional().describe("Comma-separated list of technologies. Used to auto-detect CRM/sequencing tools if booleans are not set."),
    headcount: z.string().optional().describe("Current employee headcount. Accepts a numeric string (e.g. \"3000\"). Sent as a string for Clay compatibility and coerced to integer at runtime."),
    headcount_min: z.number().int().optional().describe("Minimum headcount for the headcount_in_range signal."),
    headcount_max: z.number().int().optional().describe("Maximum headcount for the headcount_in_range signal."),
    headcount_in_range: z.boolean().optional().describe("Override: whether headcount is in your target range."),
    employee_band: z.string().optional().describe("Firmographic employee band from the Company Firmographic Enricher (Actor ID YlUtLWjfPpqykmB8g), e.g. \"201-500\". Scores via employee_band_match when it is in target_employee_bands."),
    revenue_estimate: z.string().optional().describe("Estimated annual revenue in dollars from the Company Firmographic Enricher (Actor ID YlUtLWjfPpqykmB8g). Scores via revenue_in_range. Accepts a numeric string (e.g. \"50000000\"). Coerced to integer at runtime."),
    hq_location: z.string().optional().describe("Headquarters location from the Company Firmographic Enricher (Actor ID YlUtLWjfPpqykmB8g). Carried for reference; not currently scored."),
    founded_year: z.string().optional().describe("Year the company was founded, from the Company Firmographic Enricher (Actor ID YlUtLWjfPpqykmB8g). Carried for reference; not currently scored. Accepts a numeric string (e.g. \"2015\")."),
    recently_funded: z.boolean().optional().describe("Override: whether the company was recently funded (within funded_within_days, default 540)."),
    last_funding_date: z.string().optional().describe("ISO date of last funding round (legacy field; latest_funding_date is preferred). Used to auto-detect recently_funded if the boolean is not set."),
    latest_funding_date: z.string().optional().describe("ISO date of the latest funding round (from C1 Funding & Press Signal Scanner when it ships). Drives recently_funded against funded_within_days."),
    latest_funding_amount: z.string().optional().describe("Dollar amount of the latest funding round (from C1 when it ships). Scores via well_funded when at or above min_funding_amount (default 1000000). Accepts a numeric string (e.g. \"50000000\")."),
    funding_stage: z.string().optional().describe("Funding stage (e.g. seed, series_a, series_b, growth). Used to infer recently_funded."),
    industry: z.string().optional().describe("The company's industry (from the Company Firmographic Enricher, Actor ID YlUtLWjfPpqykmB8g)."),
    industry_match: z.boolean().optional().describe("Override: whether the company's industry matches your target list."),
    target_industries: z.string().optional().describe("Comma-separated list of target industries for the industry_match signal."),
    social_platforms_found: z.string().optional().describe("Number of official social platforms found, from the Company Social Presence Mapper (Actor ID 4k6CCemkgBDz18m2h). Scores via social_presence when at or above min_social_platforms (default 2). Accepts a numeric string."),
    total_followers: z.string().optional().describe("Total social followers across platforms, from the Company Social Presence Mapper (Actor ID 4k6CCemkgBDz18m2h). Scores via strong_social_following when at or above min_total_followers (default 1000). Accepts a numeric string."),
    has_linkedin: z.string().optional().describe("Whether a company LinkedIn page was found, from the Company Social Presence Mapper (Actor ID 4k6CCemkgBDz18m2h) or the Domain to LinkedIn URL Resolver (Actor ID 3HtnSaqPHOg1Qg5gx). Contributes to social_presence. Accepts a boolean-like string."),
    has_twitter: z.string().optional().describe("Whether a company X/Twitter profile was found, from the Company Social Presence Mapper (Actor ID 4k6CCemkgBDz18m2h). Contributes to social_presence. Accepts a boolean-like string."),
    job_count: z.string().optional().describe("Number of open jobs found, from the Job Board Keyword Signal Scanner (Actor ID 4DvqpvhMR74NLcDDY). Scores via active_hiring_volume when at or above min_job_count (default 3). Accepts a numeric string."),
    keyword_match_count: z.string().optional().describe("Number of target-keyword matches found, from the Job Board Keyword Signal Scanner (Actor ID 4DvqpvhMR74NLcDDY). Scores via keyword_signal_match when at or above min_keyword_matches (default 1). Accepts a numeric string."),
  },
  },
  async (args) =>
    runActor(
      "W161DT8W4kW55dMFh",
      "ICP Fit Scorer",
      compact({
        company_domain: args.company_domain,
        company_name: args.company_name,
        template: args.template,
        scoring_config: args.scoring_config,
        icp_description: args.icp_description,
        llm_api_key: args.llm_api_key,
        llm_provider: args.llm_provider,
        fetch_signals: args.fetch_signals,
        include_explanation: args.include_explanation,
        tier_thresholds: args.tier_thresholds,
        funded_within_days: args.funded_within_days,
        min_score_to_output: args.min_score_to_output,
        previous_score: args.previous_score,
        gtm_hiring_signal: args.gtm_hiring_signal,
        gtm_role_count: args.gtm_role_count,
        uses_hubspot: args.uses_hubspot,
        uses_salesforce: args.uses_salesforce,
        uses_clay: args.uses_clay,
        crm_detected: args.crm_detected,
        seq_tool_detected: args.seq_tool_detected,
        tech_stack: args.tech_stack,
        headcount: args.headcount,
        headcount_min: args.headcount_min,
        headcount_max: args.headcount_max,
        headcount_in_range: args.headcount_in_range,
        employee_band: args.employee_band,
        revenue_estimate: args.revenue_estimate,
        hq_location: args.hq_location,
        founded_year: args.founded_year,
        recently_funded: args.recently_funded,
        last_funding_date: args.last_funding_date,
        latest_funding_date: args.latest_funding_date,
        latest_funding_amount: args.latest_funding_amount,
        funding_stage: args.funding_stage,
        industry: args.industry,
        industry_match: args.industry_match,
        target_industries: args.target_industries,
        social_platforms_found: args.social_platforms_found,
        total_followers: args.total_followers,
        has_linkedin: args.has_linkedin,
        has_twitter: args.has_twitter,
        job_count: args.job_count,
        keyword_match_count: args.keyword_match_count,
      }),
    ),
);

// 7. Company Identity Resolver
server.registerTool(
  "resolve_company_identity",
  {
    title: "Resolve Company Identity",
    description:
      "Resolve any combination of company name, domain, or LinkedIn URL into one canonical company identity: the name, primary domain, and LinkedIn company URL, each with a 0-100 confidence score plus an overall score and a match method. Cross-checks the inputs you give it, resolves the ones you do not, and flags conflicts (a domain and a LinkedIn slug that disagree) instead of merging them. Provide at least one of company_name, domain, or linkedin_url. Read-only; requires an APIFY_TOKEN and consumes Apify credits per call.",
    annotations: {
      title: "Resolve Company Identity",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      company_name: z
        .string()
        .optional()
        .describe("Company name, e.g. Stripe. Provide at least one of company_name, domain, or linkedin_url."),
      domain: z
        .string()
        .optional()
        .describe("Bare company domain, e.g. stripe.com. The strongest canonical key when provided."),
      linkedin_url: z
        .string()
        .optional()
        .describe("LinkedIn company URL (https://www.linkedin.com/company/stripe) or bare slug (stripe)."),
      skipCache: z
        .boolean()
        .optional()
        .describe("Force a fresh resolution and ignore the 7 day result cache."),
    },
  },
  async ({ company_name, domain, linkedin_url, skipCache }) => {
    if (
      (company_name === undefined || company_name === "") &&
      (domain === undefined || domain === "") &&
      (linkedin_url === undefined || linkedin_url === "")
    ) {
      return {
        isError: true,
        content: [{ type: "text", text: "Provide at least one of company_name, domain, or linkedin_url." }],
      };
    }
    return runActor(
      "lr8fTRAmZCBZmuwwh",
      "Company Identity Resolver",
      compact({
        company_name,
        domain,
        linkedin_url,
        skipCache: boolToString(skipCache),
      }),
    );
  },
);

// 8. Company Firmographic Enricher
server.registerTool(
  "enrich_company_firmographics",
  {
    title: "Enrich Company Firmographics",
    description:
      "Enrich a company domain into structured firmographics: employee band, industry, HQ, founded year, revenue estimate, logo, and description, with source provenance. Parsed from the company's schema.org/Organization JSON-LD and HTML meta tags and returned as a flat, Clay-ready JSON row with a source_signals array and a data_completeness score. Read-only; requires an APIFY_TOKEN and consumes Apify credits per call.",
    annotations: {
      title: "Enrich Company Firmographics",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      domain: z
        .string()
        .optional()
        .describe("Bare company domain to enrich, e.g. stripe.com. Provide this or domains."),
      company_name: z
        .string()
        .optional()
        .describe("Optional company name, used as a fallback label when the page does not expose one."),
      domains: z
        .array(z.string())
        .optional()
        .describe("List of bare domains for batch processing. Takes precedence over domain."),
      batchSize: z
        .number()
        .optional()
        .describe("Domains enriched concurrently per wave in batch mode. Default 5, maximum 10."),
      skipCache: z
        .boolean()
        .optional()
        .describe("Force a fresh enrichment and ignore the 7 day result cache."),
    },
  },
  async ({ domain, company_name, domains, batchSize, skipCache }) => {
    if (
      (domain === undefined || domain === "") &&
      (!Array.isArray(domains) || domains.length === 0)
    ) {
      return {
        isError: true,
        content: [{ type: "text", text: "Provide at least one of domain or domains." }],
      };
    }
    return runActor(
      "YlUtLWjfPpqykmB8g",
      "Company Firmographic Enricher",
      compact({ domain, company_name, domains, batchSize, skipCache }),
    );
  },
);

// 9. Company Social Presence Mapper
server.registerTool(
  "map_company_social_presence",
  {
    title: "Map Company Social Presence",
    description:
      "Map a company's social media presence across LinkedIn, X, Instagram, Facebook, and YouTube. Returns profile URLs and follower counts in flat Clay-ready JSON. Profiles are discovered from the company's own homepage links, a web search fallback, and pattern guessing, then validated against the company. Follower counts are extracted where public; X is URL-only (its count needs login) and Instagram and Facebook counts are best-effort. Provide at least one of company_domain or company_name. Read-only; requires an APIFY_TOKEN and consumes Apify credits per call.",
    annotations: {
      title: "Map Company Social Presence",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      company_domain: z
        .string()
        .optional()
        .describe("Bare company domain, e.g. stripe.com. Provide this or company_name."),
      company_name: z
        .string()
        .optional()
        .describe("Optional company name. Improves search accuracy and disambiguation. Provide this or company_domain."),
      platforms: z
        .array(z.enum(["linkedin", "x", "instagram", "facebook", "youtube"]))
        .optional()
        .describe("Which platforms to map. Defaults to all five."),
      includeFollowerCounts: z
        .boolean()
        .optional()
        .describe("Fetch profile pages to extract follower counts (default true). Set false for URLs only, which is cheaper."),
      skipCache: z
        .boolean()
        .optional()
        .describe("Force a fresh lookup and ignore the 7 day result cache."),
    },
  },
  async ({ company_domain, company_name, platforms, includeFollowerCounts, skipCache }) => {
    if (
      (company_domain === undefined || company_domain === "") &&
      (company_name === undefined || company_name === "")
    ) {
      return {
        isError: true,
        content: [{ type: "text", text: "Provide at least one of company_domain or company_name." }],
      };
    }
    return runActor(
      "4k6CCemkgBDz18m2h",
      "Company Social Presence Mapper",
      compact({
        company_domain,
        company_name,
        platforms,
        includeFollowerCounts: boolToString(includeFollowerCounts),
        skipCache: boolToString(skipCache),
      }),
    );
  },
);

// 10. Funding & Press Signal Scanner
server.registerTool(
  "get_funding_press_signals",
  {
    title: "Get Funding and Press Signals",
    description:
      "Scan Google News and PR wires for funding rounds, executive moves, product launches, and acquisitions at any company domain. Returns deduplicated, dated events in flat Clay-ready JSON. Read-only; requires an APIFY_TOKEN and consumes Apify credits per call.",
    annotations: {
      title: "Get Funding and Press Signals",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      domain: z
        .string()
        .describe("Company domain to scan, without https or www, e.g. stripe.com."),
      company_name: z
        .string()
        .optional()
        .describe("Optional company name hint, used when the domain does not match the brand name, e.g. Deel for deel.com."),
    },
  },
  async ({ domain, company_name }) => {
    if (domain === undefined || domain.trim() === "") {
      return {
        isError: true,
        content: [{ type: "text", text: "Provide a company domain, e.g. stripe.com." }],
      };
    }
    return runActor(
      "FS13X6dhQVgX3XOM6",
      "Funding & Press Signal Scanner",
      compact({ domain, company_name }),
    );
  },
);

// 11. Company Change-Event Feed
server.registerTool(
  "get_company_changes",
  {
    title: "Get Company Changes",
    description:
      "Monitor a company domain for changes across hiring, tech stack, funding, firmographics, and social since the last run. Returns only what changed as typed change events in flat, Clay-ready JSON. Read-only; requires an APIFY_TOKEN and consumes Apify credits per call.",
    annotations: {
      title: "Get Company Changes",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      domain: z
        .string()
        .describe("Company domain to monitor, without https or www, e.g. stripe.com."),
      company_name: z
        .string()
        .optional()
        .describe("Optional company name hint, used when the domain does not match the brand name, e.g. Deel for deel.com."),
      previous_snapshot: z
        .record(z.unknown())
        .optional()
        .describe("Snapshot object returned by a prior run. Supply it and it is the baseline instead of stored state, which is what makes a scheduled run cheap."),
      sub_actor_timeout_secs: z
        .number()
        .int()
        .optional()
        .describe("Per-child run timeout in seconds. Children run in parallel, so total wall time is about the slowest child. Default: 90."),
    },
  },
  async ({ domain, company_name, previous_snapshot, sub_actor_timeout_secs }) => {
    if (domain === undefined || domain.trim() === "") {
      return {
        isError: true,
        content: [{ type: "text", text: "Provide a company domain, e.g. stripe.com." }],
      };
    }
    return runActor(
      "oX44rS0fkEJ3rXLWe",
      "Company Change-Event Feed",
      compact({ domain, company_name, previous_snapshot, sub_actor_timeout_secs }),
    );
  },
);

// 12. AI Tooling Detector
server.registerTool(
  "detect_ai_tooling",
  {
    title: "Detect AI Tooling",
    description:
      "Given a company domain, determine how far that company has gone with AI. Returns an ai_maturity tier of none, declared (says AI but nothing observable is running), deployed (AI tooling is live on the site), or commercialized (the pricing page charges for AI via credits, tokens, an add-on, an AI-named plan, or a per-outcome price), plus the detected AI vendors, validated llms.txt status, robots.txt AI-crawler policy, and the evidence behind the verdict. A domain behind a bot challenge returns blocked=true at low confidence rather than a false negative. Returns flat, Clay-ready JSON. Read-only; requires an APIFY_TOKEN and consumes Apify credits per domain analyzed.",
    annotations: {
      title: "Detect AI Tooling",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      domain: z
        .string()
        .optional()
        .describe("Company domain to analyze, without https or www, e.g. intercom.com."),
      domains: z
        .array(z.string())
        .optional()
        .describe("Batch mode: several company domains analyzed in one call. Takes precedence over domain."),
      check_pricing: z
        .boolean()
        .optional()
        .describe("Fetch and score the pricing page. Default true. Setting this false is faster but caps the result at 'deployed', because 'commercialized' can only be proven on a pricing page."),
      skipCache: z
        .boolean()
        .optional()
        .describe("Force a fresh analysis and ignore the 7 day result cache."),
      request_timeout_ms: z
        .number()
        .int()
        .optional()
        .describe("Per-request timeout in milliseconds. 3000 to 20000. Default: 9000."),
    },
  },
  async ({ domain, domains, check_pricing, skipCache, request_timeout_ms }) => {
    const hasBatch = Array.isArray(domains) && domains.length > 0;
    if (!hasBatch && (domain === undefined || domain.trim() === "")) {
      return {
        isError: true,
        content: [{ type: "text", text: "Provide either domain (e.g. intercom.com) or domains (an array)." }],
      };
    }
    return runActor(
      "EwkHhmqiuJgRoVEbE",
      "AI Tooling Detector",
      compact({
        domain: hasBatch ? undefined : domain,
        domains: hasBatch ? domains : undefined,
        check_pricing,
        skipCache,
        request_timeout_ms,
      }),
    );
  },
);

// 13. Outbound Infrastructure Fingerprint
server.registerTool(
  "fingerprint_outbound_infrastructure",
  {
    title: "Fingerprint Outbound Infrastructure",
    description:
      "Given a company domain, determine whether that company runs cold email outbound and on what stack. Returns a runs_outbound verdict of program (a deliberate cold outbound setup), light (one weak signal), none, or unknown, with the evidence behind it. The strongest signal is the lookalike sending domains a real program leaves behind: domains like getcompany.com or company-mail.com that carry their own mail and redirect back to the primary site. Also returns the inbox provider (Google Workspace, Microsoft 365 and others) for the primary domain and each sending domain, any detected sending platform (Outreach, Salesloft, Lemlist, Instantly, Smartlead, Apollo and more), registration clusters showing sending domains bought on the same day, cold email infrastructure vendors, and SPF, DKIM and DMARC posture. Sending platform recall is partial by design: sequencers that connect over OAuth to a customer's own mailbox leave no DNS trace, so an empty sending_platforms means little while a populated one is solid. Public DNS and HTTP redirects only. Returns flat, Clay-ready JSON. Read-only; requires an APIFY_TOKEN and consumes Apify credits per domain analyzed.",
    annotations: {
      title: "Fingerprint Outbound Infrastructure",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      domain: z
        .string()
        .optional()
        .describe("Company domain to analyze, without https or www, e.g. smartlead.ai."),
      domains: z
        .array(z.string())
        .optional()
        .describe("Batch mode: several company domains analyzed in one call. Takes precedence over domain."),
      scan_sending_domains: z
        .boolean()
        .optional()
        .describe("Scan for lookalike sending domains. Default true. The strongest signal and the slowest step; turning it off caps the verdict at what platform and deliverability signals alone can prove."),
      sending_domain_depth: z
        .enum(["deep", "standard"])
        .optional()
        .describe("deep (default) checks .com, .co, .io, .net and .org. standard drops .net and .org."),
      check_deliverability: z
        .boolean()
        .optional()
        .describe("Add a blacklist check and a 0-100 health score by running the separate Domain Deliverability Checker actor, which bills its own per-domain rate on top of this one. Default false. SPF, DKIM and DMARC are read from DNS either way."),
      skipCache: z
        .boolean()
        .optional()
        .describe("Force a fresh analysis and ignore the 7 day result cache."),
      max_sending_domain_probes: z
        .number()
        .int()
        .optional()
        .describe("Cap on how many candidate sending domains are probed per company. Lower it to bound run time on companies with many lookalike domains."),
      request_timeout_ms: z
        .number()
        .int()
        .optional()
        .describe("Per-HTTP-request timeout in milliseconds."),
      dns_timeout_ms: z
        .number()
        .int()
        .optional()
        .describe("Per-DNS-lookup timeout in milliseconds."),
    },
  },
  async ({ domain, domains, scan_sending_domains, sending_domain_depth, check_deliverability, skipCache, max_sending_domain_probes, request_timeout_ms, dns_timeout_ms }) => {
    const hasBatch = Array.isArray(domains) && domains.length > 0;
    if (!hasBatch && (domain === undefined || domain.trim() === "")) {
      return {
        isError: true,
        content: [{ type: "text", text: "Provide either domain (e.g. smartlead.ai) or domains (an array)." }],
      };
    }
    return runActor(
      "v43UJC8r7qW7cBSTG",
      "Outbound Infrastructure Fingerprint",
      compact({
        domain: hasBatch ? undefined : domain,
        domains: hasBatch ? domains : undefined,
        scan_sending_domains,
        sending_domain_depth,
        check_deliverability,
        skipCache,
        max_sending_domain_probes,
        request_timeout_ms,
        dns_timeout_ms,
      }),
    );
  },
);

// 14. Publication Cadence Tracker
server.registerTool(
  "track_publication_cadence",
  {
    title: "Track Publication Cadence",
    description:
      "Given a company domain, measure how much long-form work that company publishes and whether the rate is rising or falling. Returns post counts for the last 30 days, 90 days and 12 months, a monthly average, and a cadence_trend of accelerating, steady, declining, dormant or unknown, with the percent change behind it. The trend compares the last 90 days against the prior 275 days, both normalized to posts per month. Also returns the blog URL, the format mix (blog posts, guides, reports, case studies, whitepapers, podcasts, videos, press releases, research), the number of distinct bylines, and how the post list was discovered. This measures EDITORIAL output volume, not product changelogs: a release feed is detected and rejected rather than counted. Publication dates are read from the post pages, because sitemap lastmod was measured to be a modification date running later than publication by a median of 151 to 1653 days. When a site's date field tracks edits rather than publication, date_source_reliable comes back false and every count is nulled rather than reported wrong, so read that field before quoting a number. Counts are a census when the archive fits the page budget and a scaled even sample otherwise, flagged by counts_are_estimate. Public sitemaps, feeds and pages only. Returns flat, Clay-ready JSON. Read-only; requires an APIFY_TOKEN and consumes Apify credits per domain analyzed.",
    annotations: {
      title: "Track Publication Cadence",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      domain: z
        .string()
        .optional()
        .describe("Company domain to analyze, without https or www, e.g. zapier.com."),
      domains: z
        .array(z.string())
        .optional()
        .describe("Batch mode: several company domains analyzed in one call. Takes precedence over domain."),
      max_pages_to_date: z
        .number()
        .int()
        .min(20)
        .max(800)
        .optional()
        .describe("How many post pages to fetch per domain for dating. Default 400. Above this cap the counts are estimated from an even sample and counts_are_estimate is set true."),
      domain_time_budget_ms: z
        .number()
        .int()
        .min(15000)
        .max(240000)
        .optional()
        .describe("Hard wall-clock ceiling per domain, default 75000. When nearly spent the crawl stops and the row is returned with partial_result true rather than timing out."),
      skipCache: z
        .boolean()
        .optional()
        .describe("Force a fresh crawl and ignore the 3 day result cache."),
      page_concurrency: z
        .number()
        .int()
        .optional()
        .describe("How many pages are fetched concurrently within one domain."),
      max_sitemap_fetches: z
        .number()
        .int()
        .optional()
        .describe("Cap on how many sitemap files are fetched per domain. Lower it to bound run time on deeply nested sitemap indexes."),
      request_timeout_ms: z
        .number()
        .int()
        .optional()
        .describe("Per-HTTP-request timeout in milliseconds."),
    },
  },
  async ({ domain, domains, max_pages_to_date, domain_time_budget_ms, skipCache, page_concurrency, max_sitemap_fetches, request_timeout_ms }) => {
    const hasBatch = Array.isArray(domains) && domains.length > 0;
    if (!hasBatch && (domain === undefined || domain.trim() === "")) {
      return {
        isError: true,
        content: [{ type: "text", text: "Provide either domain (e.g. zapier.com) or domains (an array)." }],
      };
    }
    return runActor(
      "TbLwaUUATdYb6wp4N",
      "Publication Cadence Tracker",
      compact({
        domain: hasBatch ? undefined : domain,
        domains: hasBatch ? domains : undefined,
        max_pages_to_date,
        domain_time_budget_ms,
        skipCache,
        page_concurrency,
        max_sitemap_fetches,
        request_timeout_ms,
      }),
    );
  },
);


// 15. Sequencer Lead Push
server.registerTool(
  "push_leads_to_sequencer",
  {
    title: "Push Leads to Sequencer",
    description:
      "Push enriched lead rows into an existing Instantly or Smartlead campaign. Maps common Clay column names onto each sequencer's own field names, optionally drops leads below a minimum ICP score, optionally deduplicates against the leads already in the destination campaign, and sends the rest in batches. Returns one flat summary row: how many leads were received, dropped for having no usable email, dropped by the ICP gate, dropped as duplicates, eligible, actually created by the sequencer, skipped by the sequencer, and failed, plus the vendor's own error message per failed address. The campaign must already exist; this does not create campaigns or write sequence copy. Set dry_run true to get back the exact request payload that would be sent without creating a single lead and without being charged, which is the safe way to check a mapping against a new campaign. Billing is per lead the sequencer confirms it created, so gated, duplicate, skipped, failed and dry-run leads are all free. Instantly uses API v2 and needs a v2 key; Smartlead uses API v1. Requires an APIFY_TOKEN and consumes Apify credits. This WRITES to your sequencer campaign unless dry_run is true.",
    annotations: {
      title: "Push Leads to Sequencer",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      sequencer: z
        .enum(["instantly", "smartlead"])
        .describe("Which sequencer to push to. Instantly uses API v2, Smartlead uses API v1."),
      api_key: z
        .string()
        .optional()
        .describe("Your Instantly v2 API key or your Smartlead API key. An Instantly v1 key will not work: v1 was deprecated on January 19, 2026. Required for any run that calls the sequencer. A dry run with deduplicate false makes no calls and needs no key."),
      campaign_id: z
        .string()
        .describe("The target campaign in the sequencer. It must already exist. Instantly campaign IDs are UUIDs; Smartlead campaign IDs are numeric."),
      leads: z
        .array(z.record(z.unknown()))
        .optional()
        .describe("Lead rows to push. Each row needs an email at minimum. Takes precedence over dataset_id when both are set."),
      dataset_id: z
        .string()
        .optional()
        .describe("An Apify dataset ID from an upstream run, for example the output of score_icp_fit. Used only when leads is empty."),
      min_icp_score: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Drop leads whose icp_score is below this number. Default 0, which pushes everything. Rows with no icp_score are always kept."),
      deduplicate: z
        .boolean()
        .optional()
        .describe("Read the campaign's existing leads first and drop any email already there. Default true. This is a read, so it needs an API key even on a dry run."),
      dry_run: z
        .boolean()
        .optional()
        .describe("Run every step, return the exact payload that would be sent, and make zero write calls. Creates no leads and charges nothing. Default false."),
      field_mapping: z
        .record(z.string())
        .optional()
        .describe("Override the default Clay column to sequencer field map. Keys are your column names, values are the sequencer field names. Set a value to an empty string to drop that column. A target the sequencer does not have is sent as a custom variable rather than rejected."),
      custom_variables: z
        .array(z.string())
        .optional()
        .describe("Extra column names to pass through as custom variables under their own name. Columns that are neither mapped nor listed here are dropped."),
    },
  },
  async ({ sequencer, api_key, campaign_id, leads, dataset_id, min_icp_score, deduplicate, dry_run, field_mapping, custom_variables }) => {
    const hasLeads = Array.isArray(leads) && leads.length > 0;
    const hasDataset = dataset_id !== undefined && dataset_id !== "";
    if (!hasLeads && !hasDataset) {
      return {
        isError: true,
        content: [{ type: "text", text: "Provide either leads (an array of lead rows) or dataset_id (an Apify dataset from an upstream run)." }],
      };
    }
    return runActor(
      "0Jv27VeWM5tSZQs9x",
      "Sequencer Lead Push",
      compact({
        sequencer,
        api_key,
        campaign_id,
        leads: hasLeads ? leads : undefined,
        dataset_id: hasLeads ? undefined : dataset_id,
        min_icp_score,
        deduplicate,
        dry_run,
        field_mapping,
        custom_variables,
      }),
    );
  },
);


// ---------------------------------------------------------------------------
// 16 to 20, added 2026-08-12. Five actors that had a standalone wrapper on npm
// and were not in the bundle, so a buyer installing the suite got 15 of the
// fleet's 20 published tools and no way to tell which five were missing.
// Definitions are copied verbatim from each standalone wrapper so the two
// packages cannot describe the same tool differently.
// ---------------------------------------------------------------------------
// 16. agent accessibility auditor
server.registerTool(
  "audit_agent_accessibility",
  {
    title: "Audit Agent Accessibility",
    description:
      "Give it a domain and it returns whether an AI agent can read that site, and what the site's policy says, as one flat row of 42 fields across five families: the llms.txt family including llms-full.txt and ai.txt, robots.txt AI crawler policy including the newer Content Signal directives, structured data presence and health across JSON-LD, microdata, Open Graph and canonical, render mode, and machine readable endpoint discovery covering sitemap, OpenAPI, well known files and feeds. Every field is a fact read off a fetch. No model is called at any point, so the same domain returns the same row today and next month unless the site actually changed. Twelve requests per domain, typically 2 to 4 seconds. Built for a technical SEO or growth engineer preparing a site for AI crawlers, or an agency selling that work and needing a before and after audit across a client list. Requires an APIFY_TOKEN and consumes Apify credits. Read only.",
    annotations: {
      title: "Audit Agent Accessibility",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
    domain: z.string().describe("One company domain, for example vercel.com. Protocol and path are stripped."),
    check_endpoints: z.boolean().optional().describe("Probes sitemap, OpenAPI, well known files and feeds. Adds 7 concurrent requests. Default: true."),
    check_structured_data: z.boolean().optional().describe("Parses JSON-LD, microdata, Open Graph and canonical off the homepage. Costs no extra requests. Default: true."),
    skipCache: z.enum(["false", "true"]).optional().describe("Leave as false to use the 7 day cache. Set to true to re-audit the domain from scratch. Default: \"false\"."),
    },
  },
  async (args) =>
    runActor("anxbRv0lKrpQ1pnua", "Agent Accessibility Auditor", compact(args as Record<string, unknown>)),
);

// 17. contact classifier
server.registerTool(
  "classify_contact",
  {
    title: "Classify Contact",
    description:
      "One contact in, one classified row out. Give it a job title and it returns the department, the seniority level, a seniority_rank from 1 to 12 you can filter with a comparison, and classification_rule, the named rule that fired, so every decision is auditable. The classification is a deterministic rule table: it needs no API key, calls no model, and returns the same answer for the same title every time. Only job_title is required. full_name and company_domain are read only when verify_position is on, which checks whether the person is still listed on their employer's own website and adds roughly 3 seconds and 9 requests per contact. The optional LLM fallback for titles the rules cannot place runs on your own key, set as the LLM_API_KEY secret environment variable on your own copy of the actor, and only the title is ever sent, never the person's name. With no key set those titles come back null rather than failing the row. This actor does not discover people: the name and title come from you. Requires an APIFY_TOKEN and consumes Apify credits. Read only.",
    annotations: {
      title: "Classify Contact",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
    job_title: z.string().describe("The contact's job title, exactly as you hold it. Classified by deterministic rules with no API key needed."),
    full_name: z.string().optional().describe("Only needed for position verification. Classification works without it. This name is never sent to any language model."),
    company_domain: z.string().optional().describe("Only needed for position verification. The company's website domain, with or without https."),
    verify_position: z.boolean().optional().describe("Check whether the person is still listed on their employer's own website. Off by default. Adds roughly 3 seconds and 9 requests per contact, and needs both the name and the domain. Default: false."),
    use_llm_fallback: z.boolean().optional().describe("Off by default. When on, titles the rules cannot place are sent to your own model using the LLM_API_KEY secret environment variable you set on your copy of this Actor. Only the title is sent, never the person's name. With no key set the Actor still returns a row, it just leaves those titles null. Default: false."),
    llm_provider: z.enum(["openai", "anthropic", "google"]).optional().describe("Which provider your LLM_API_KEY belongs to. Only read when the LLM fallback is on. Default: \"openai\"."),
    llm_model: z.string().optional().describe("Model id passed straight through to the provider. Only read when the LLM fallback is on. Default: \"gpt-4o-mini\"."),
    skipCache: z.enum(["false", "true"]).optional().describe("Set to true to ignore cached results and classify from scratch. Default: \"false\"."),
    },
  },
  async (args) =>
    runActor("0lGSeYJmniXhGANnO", "Contact Classifier", compact(args as Record<string, unknown>)),
);

// 18. event presence index
server.registerTool(
  "map_company_event_presence",
  {
    title: "Map Company Event Presence",
    description:
      "Give it a company domain. It returns the third party conferences and trade shows that company publicly says it attends, with a year for each where one can be resolved, as one flat row. The search runs against the company's own domain, which is what stops a brand collision returning another company's events. The company's own conference is reported separately and is never mixed into the attendance list. It finds events for roughly 2 companies in 10, and an empty row is an honest empty row rather than a guess: read coverage, fetch_status and queries_failed to tell a company with no published events apart from a search that could not see. Events dated outside the years you ask for are still returned and flagged, so filter on event year rather than assuming the input filtered for you. This is not an events database and not an exhibitor list: it takes a company and reports what that company publishes. Requires an APIFY_TOKEN and consumes Apify credits. Read only.",
    annotations: {
      title: "Map Company Event Presence",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
    domain: z.string().describe("A single company domain, for example 6sense.com. Protocol and path are stripped."),
    company_name: z.string().optional().describe("Improves matching when the brand differs from the domain stem, for example Gong for gong.io. Derived from the domain when left empty."),
    years: z.string().optional().describe("Comma separated, for example 2025,2026. Events dated outside this set are still returned and flagged. Sent as a string so it works from Clay. Default: \"2025,2026\"."),
    include_own_events: z.boolean().optional().describe("Reports whether the company runs its own conference as a separate field. It is never mixed into the attendance list. Default: true."),
    max_queries: z.string().optional().describe("Between 1 and 5. Each query costs roughly 0.8 seconds plus a 1.3 second pause. 2 is the measured sweet spot: search engines refuse a third query from the same container almost every time, and the third query added no events the first two did not already find. Sent as a string so it works from Clay. Default: \"2\"."),
    skipCache: z.enum(["false", "true"]).optional().describe("false uses the 21 day result cache. true forces a fresh look. Default: \"false\"."),
    },
  },
  async (args) =>
    runActor("WLhMy8fMDgsxdYxv5", "Event Presence Index", compact(args as Record<string, unknown>)),
);

// 19. legal entity resolver
server.registerTool(
  "resolve_legal_entity",
  {
    title: "Resolve Legal Entity",
    description:
      "Give it a company domain and it returns the registered legal entity behind it: legal name, company number, jurisdiction, status, entity type, LEI and VAT number, as one flat row with a full audit trail of what was rejected and why. Three registers are queried: UK Companies House, GLEIF and SEC EDGAR. Register search endpoints are fuzzy and always return something, so by default a record is accepted only when the normalized legal names are identical. That is why roughly 6 domains in 10 resolve rather than 10 in 10, and why a null here is a trustworthy answer rather than a gap. Read match_method, match_confidence and rejected_candidates before acting on a match. Setting match_strictness to fuzzy will hand you a confidently wrong company on most domains and should be treated as a research mode, not a default. This is not a company database and not a credit or risk product. Requires an APIFY_TOKEN and consumes Apify credits. Read only.",
    annotations: {
      title: "Resolve Legal Entity",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
    domain: z.string().describe("A single company domain, for example monzo.com. Protocol and path are stripped."),
    legal_name_hint: z.string().optional().describe("Skips the domain lookup and goes straight to the registers with this name. Use it when you already have the legal name and just want the register record."),
    jurisdiction_hint: z.string().optional().describe("ISO-2 country code, for example GB or US. Narrows which registers are queried and cuts latency. Leave empty to query every register."),
    match_strictness: z.enum(["exact", "fuzzy"]).optional().describe("exact accepts a register record only when the normalized legal names are equal, which is the default and the recommendation. fuzzy returns the best scoring candidate with a confidence below 100 and a warning in rejected_candidates. Register search is fuzzy and always returns something, so fuzzy mode will hand you a confidently wrong company on most domains. Default: \"exact\"."),
    validate_vat: z.boolean().optional().describe("Runs any VAT number found on the company's own pages through the EU VIES service and returns the name VIES holds for it, as a cross-check against the register name. Default: true."),
    skipCache: z.enum(["false", "true"]).optional().describe("false uses the cache: 90 days for a resolved company, 7 days for a null. true forces a fresh look. Default: \"false\"."),
    },
  },
  async (args) =>
    runActor("KHFyPCDIx7CyqULYm", "Legal Entity Resolver", compact(args as Record<string, unknown>)),
);

// 20. public award monitor
server.registerTool(
  "monitor_public_awards",
  {
    title: "Monitor Public Awards",
    description:
      "Pick a public award register and a time window and it returns the companies that won public work in it, one flat row per winning company rather than one per award, with award count, total value, largest award, awarding body, award date, a deep link to the source record, and a resolved company domain. Five registers are covered: US federal contracts and US federal grants from USASpending, NIH SBIR and STTR from NIH RePORTER, and UK Contracts Finder and UK Find a Tender. This reports awards that have already been made, so it is not a tender feed and will not tell you what is open to bid on. US federal data lags about two days, so a one day window on a US register returns little or nothing. Winners are sorted by total award value and max_entities is the hard cap on billed rows. Requires an APIFY_TOKEN and consumes Apify credits. Read only.",
    annotations: {
      title: "Monitor Public Awards",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
    register: z.enum(["us_federal_contracts", "us_federal_grants", "us_nih_sbir", "uk_contracts_finder", "uk_find_a_tender"]).describe("Which award register to read. US federal contracts and grants come from USASpending, NIH SBIR and STTR from NIH RePORTER, and the two UK registers from Contracts Finder and Find a Tender. Default: \"us_federal_contracts\"."),
    window_days: z.string().optional().describe("How many days back from today to read awards for. 1 to 90. US federal data lags about two days, so do not use a one day window on the US registers. Sent as a string so it works from Clay. Default: \"7\"."),
    min_award_value: z.string().optional().describe("Drops awards below this amount in the register's own currency. Set to 0 to keep everything. Sent as a string so it works from Clay. Default: \"100000\"."),
    max_entities: z.string().optional().describe("Hard cap on billed rows. 1 to 1000. Winners are sorted by total award value, and the run log says how many were dropped. Sent as a string so it works from Clay. Default: \"100\"."),
    exclude_government_recipients: z.boolean().optional().describe("Drops winners that are themselves government, universities, or public authorities. Leave this on for the grant registers or you get state departments of education instead of companies. Default: true."),
    resolve_domains: z.boolean().optional().describe("Looks up each winner's website. Turning it off makes the run roughly 20x faster and returns recipient_domain as null with domain_status not_attempted. Default: true."),
    domain_confidence_floor: z.enum(["strict", "standard", "loose"]).optional().describe("How sure the actor has to be before it gives you a domain. Strict returns fewer domains and almost no wrong ones. Loose returns the most domains and about a third of them are wrong. Default: \"standard\"."),
    },
  },
  async (args) =>
    runActor("zhEtllASykOcx9hJ8", "Government Contract Award Monitor", compact(args as Record<string, unknown>)),
);


// 21. LinkedIn Post Tracker and Comment Capture, added 2026-08-12 when the
// actor went public and was onboarded into the audited fleet. Definition copied
// verbatim from the standalone wrapper so the two cannot describe it
// differently.
server.registerTool(
  "capture_linkedin_posts_and_commenters",
  {
    title: "Capture LinkedIn Posts and Commenters",
    description:
      "Point it at LinkedIn person profiles or company pages and it returns their recent posts as flat rows, with the real reaction and comment counts on every one, plus the commenters LinkedIn shows publicly. No cookies, no LinkedIn account, no credentials of any kind. One dataset carries three row types told apart by row_type: post, engager and notice, so filter on row_type before loading a table. post_id is the numeric activity URN and is stable across runs and across both permalink spellings, which makes it safe as a primary key and as a have-I-already-seen-this check. Read the limits before relying on the commenters: LinkedIn renders about ten top-level comments to a logged-out visitor whatever the real total, measured whole-run coverage was 3.7 percent, and roughly 30 percent of comment rows carry no timestamp. Reactor identities are not served to a logged-out visitor at all, so every post row carries the real reaction_count and reactors_status says unavailable_without_login. Every row carries degraded and degradation_reason: filter on degraded before you trust an absence. Requires an APIFY_TOKEN and consumes Apify credits. Read only.",
    annotations: {
      title: "Capture LinkedIn Posts and Commenters",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
    profile_urls: z.array(z.string()).optional().describe("LinkedIn person profile URLs whose recent posts you want, for example https://www.linkedin.com/in/williamhgates. Country subdomains such as uk.linkedin.com are fine. Supply this, company_urls, or both."),
    company_urls: z.array(z.string()).optional().describe("LinkedIn company page URLs whose recent posts you want, for example https://www.linkedin.com/company/microsoft. Supply this, profile_urls, or both."),
    posted_since: z.string().optional().describe("ISO date or timestamp, for example 2026-08-01. Posts published before this are skipped BEFORE anything is charged, so a scheduled run that finds nothing new costs the actor start and nothing else. Leave empty to take everything the page advertises."),
    collect_commenters: z.boolean().optional().describe("Return one row per person who commented, with name, profile URL, comment text and comment likes. Turn it off to collect posts only, in which case commenters_collected comes back null rather than 0, because the actor did not look. Default: true."),
    collect_reactors: z.boolean().optional().describe("LinkedIn serves no reactor identities to a logged-out visitor, so this returns no reaction rows whatever you set. It exists so the limit is visible rather than silent, and it adds one notice row per run. Set it to false to suppress that row. Default: true."),
    max_engagers_per_post: z.number().int().min(0).max(100).optional().describe("Caps the engager rows charged per post. LinkedIn shows about ten comments to a logged-out visitor, so ten is the platform ceiling and raising this above ten does nothing. Set it to 0 to pay for posts only. Default: 10."),
    use_residential_proxy: z.boolean().optional().describe("Off by default, which is what the pricing assumes and what was measured. Turn it on only if LinkedIn starts refusing the platform's datacenter addresses. Apify bills residential bandwidth on top of this actor's events. Default: false."),
    },
  },
  async (args) =>
    runActor("oiGLNPuaf5BRaz9K5", "LinkedIn Post Tracker and Comment Capture", compact(args as Record<string, unknown>)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
