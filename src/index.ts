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

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable
// 17-char key that survives Store renames). The /v2/acts/{id} endpoint accepts
// it directly. We use IDs rather than the mambalabs~slug path so a Store rename
// never breaks these calls.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const url = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?timeout=300`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APIFY_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(input),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }

    let message: string;
    switch (response.status) {
      case 401:
        message = "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
        break;
      case 402:
        message =
          "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
        break;
      case 408:
        message = `The ${actorLabel} run timed out after 300 seconds. Try again, or run the actor on Apify directly for longer jobs.`;
        break;
      default:
        message = `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
    return { isError: true, content: [{ type: "text", text: message }] };
  }

  const items = await response.json();
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
  },
  },
  async ({ domain, role_filter, ats_slug }) =>
    runActor(
      "D7O1SA2EqwHGsGr1P",
      "GTM Hiring Signal Scraper",
      compact({ domain, role_filter, ats_slug }),
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
    domain: z.string().describe("Bare company domain, e.g. stripe.com"),
    crawl_additional_pages: z
      .boolean()
      .optional()
      .describe("Crawl up to 2 extra pages for better coverage. Defaults to true when omitted."),
  },
  },
  async ({ domain, crawl_additional_pages }) =>
    runActor(
      "qyd7nNyqFPelQViBx",
      "GTM Tech Stack Signal Enrichment",
      compact({ domain, crawl_additional_pages }),
    ),
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
  },
  },
  async ({ company_domain, company_name }) => {
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
      compact({ company_domain, company_name }),
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
      "oX44rS0fkEJ3rXLWe",
      "Company Change-Event Feed",
      compact({ domain, company_name }),
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
