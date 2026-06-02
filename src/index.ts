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
if (!APIFY_TOKEN) {
  console.error(
    [
      "APIFY_TOKEN is not set.",
      "This server needs an Apify API token to run the Mamba Labs GTM Suite actors.",
      "Create a token at https://console.apify.com/account/integrations and pass it as the APIFY_TOKEN environment variable.",
    ].join("\n"),
  );
  process.exit(1);
}

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

// Shared caller. The tilde between the org name and the actor name is Apify's
// required separator for the org/actor path. It is not a slash.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
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
server.tool(
  "scan_gtm_hiring_signals",
  "Scan company career pages to detect GTM hiring activity. Returns sales, marketing, and revenue operations job postings across Greenhouse, Lever, and Ashby as a flat, Clay-ready JSON row.",
  {
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
  async ({ domain, role_filter, ats_slug }) =>
    runActor(
      "mambalabs~gtm-hiring-signal-scraper",
      "GTM Hiring Signal Scraper",
      compact({ domain, role_filter, ats_slug }),
    ),
);

// 2. GTM Tech Stack Signal Enrichment
server.tool(
  "detect_gtm_tech_stack",
  "Detect which GTM tools a company uses from its public website. Returns CRM, sequencer, and marketing automation signals with per-tool boolean flags as a flat, Clay-ready JSON row.",
  {
    domain: z.string().describe("Bare company domain, e.g. stripe.com"),
    crawl_additional_pages: z
      .boolean()
      .optional()
      .describe("Crawl up to 2 extra pages for better coverage. Defaults to true when omitted."),
  },
  async ({ domain, crawl_additional_pages }) =>
    runActor(
      "mambalabs~gtm-tech-stack-signal-scraper",
      "GTM Tech Stack Signal Enrichment",
      compact({ domain, crawl_additional_pages }),
    ),
);

// 3. GTM Signals Aggregator
server.tool(
  "aggregate_gtm_signals",
  "Aggregate a company's GTM signals into one composite score. Runs hiring and tech-stack detection in one call and returns a composite score, recommended action, and optional summary as a flat, Clay-ready JSON row.",
  {
    company_domain: z.string().describe("Bare company domain, e.g. stripe.com"),
    include_summary: z.boolean().optional().describe("Include a plain-English gtm_signal_summary."),
    explain_mode: z
      .boolean()
      .optional()
      .describe("If true, the summary becomes a longer, more detailed explanation."),
  },
  async ({ company_domain, include_summary, explain_mode }) =>
    runActor(
      "mambalabs~gtm-signals-aggregator",
      "GTM Signals Aggregator",
      compact({ company_domain, include_summary, explain_mode }),
    ),
);

// 4. Job Board Keyword Signal Scanner
server.tool(
  "scan_job_board_keywords",
  "Scan a company's job board for roles in chosen categories across Greenhouse, Lever, Ashby, Workday, and Rippling. Returns matched role counts and titles per category as a flat, Clay-ready JSON row.",
  {
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
  async ({
    company_domain,
    role_categories,
    custom_keywords,
    enable_fallback,
    previous_roles_detected,
    previous_run_date,
  }) =>
    runActor(
      "mambalabs~job-board-keyword-signal-scanner",
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
server.tool(
  "resolve_linkedin_url",
  "Resolve a company domain or name to its LinkedIn company URL with a confidence score, firmographics, and social links as a flat, Clay-ready JSON row. Provide at least one of company_domain or company_name.",
  {
    company_domain: z
      .string()
      .optional()
      .describe("Bare company domain, e.g. stripe.com. Required if company_name is not provided."),
    company_name: z.string().optional().describe("Company name. Required if company_domain is not provided."),
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
      "mambalabs~domain-to-linkedin-url-resolver",
      "Domain to LinkedIn URL Resolver",
      compact({ company_domain, company_name }),
    );
  },
);

// 6. ICP Fit Scorer (single-company scoring surface)
server.tool(
  "score_icp_fit",
  "Score a company against your ideal customer profile (ICP) using weighted signals. Returns a 0 to 100 icp_score, an A to D icp_tier, and a per-signal breakdown as a flat, Clay-ready JSON row. Define your ICP with a template, scoring_config, or plain-English icp_description (which requires llm_api_key).",
  {
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
  async (args) =>
    runActor(
      "mambalabs~icp-fit-scorer",
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

const transport = new StdioServerTransport();
await server.connect(transport);
