# Mamba Labs GTM Suite MCP Server

[![Smithery](https://smithery.ai/badge/mambabuilt/mcp-gtm-suite)](https://smithery.ai/servers/mambabuilt/mcp-gtm-suite)

One MCP server that exposes the entire Mamba Labs GTM Suite. Install a single package and get all six go-to-market tools in your MCP client, each wrapping a Mamba Labs actor on Apify and returning Clay-ready flat JSON.

## What it does

This server gives an AI client six GTM tools in one place:

- `scan_gtm_hiring_signals`: detect GTM hiring activity from career pages
- `detect_gtm_tech_stack`: detect CRM, sequencer, and marketing automation tools
- `aggregate_gtm_signals`: combine hiring and tech-stack signals into one composite score
- `scan_job_board_keywords`: scan job boards for roles in any category
- `resolve_linkedin_url`: resolve a domain or name to a LinkedIn company URL
- `score_icp_fit`: score a company against your ideal customer profile

All of the work runs on Apify. This package is a thin client that routes each tool call to the right actor and hands back the result.

## Quick start

You need Node.js 18 or newer and an Apify account with an API token.

Add this to your Claude Desktop config:

```json
{
  "mcpServers": {
    "mamba-gtm-suite": {
      "command": "npx",
      "args": ["-y", "@mambalabsdev/mcp-gtm-suite"],
      "env": {
        "APIFY_TOKEN": "your-apify-token"
      }
    }
  }
}
```

Get your token at https://console.apify.com/account/integrations, paste it in, and restart Claude Desktop. All six tools will be available.

## Prerequisites

- Node.js 18 or newer
- An Apify account with an API token

## Example prompts

- "Profile stripe.com: hiring signals, tech stack, and an overall GTM score."
- "Find figma.com's LinkedIn URL, then score it against my ICP."
- "Is openai.com hiring for GTM, and what CRM do they use?"
- "Scan datadoghq.com's job board for Engineering and Finance roles."

## Tools and inputs

Each tool maps to one Apify actor. Inputs mirror the actor, minus deprecated and batch-only fields:

- `scan_gtm_hiring_signals`: `domain` (required), `role_filter`, `ats_slug`
- `detect_gtm_tech_stack`: `domain` (required), `crawl_additional_pages`
- `aggregate_gtm_signals`: `company_domain` (required), `include_summary`, `explain_mode`
- `scan_job_board_keywords`: `company_domain` (required), `role_categories` (required), `custom_keywords`, `enable_fallback`, `previous_roles_detected`, `previous_run_date`
- `resolve_linkedin_url`: `company_domain` or `company_name` (at least one)
- `score_icp_fit`: `company_domain` (required), plus `template`, `scoring_config`, `icp_description` (+ `llm_api_key`, `llm_provider`), `fetch_signals`, `include_explanation`

## Individual servers

Prefer one tool at a time? Each actor also ships as its own MCP package:

- [`@mambalabsdev/mcp-gtm-hiring-signal-scraper`](https://github.com/mambalabsdev/mcp-gtm-hiring-signal-scraper)
- [`@mambalabsdev/mcp-gtm-tech-stack-signal-scraper`](https://github.com/mambalabsdev/mcp-gtm-tech-stack-signal-scraper)
- [`@mambalabsdev/mcp-gtm-signals-aggregator`](https://github.com/mambalabsdev/mcp-gtm-signals-aggregator)
- [`@mambalabsdev/mcp-job-board-keyword-signal-scanner`](https://github.com/mambalabsdev/mcp-job-board-keyword-signal-scanner)
- [`@mambalabsdev/mcp-domain-to-linkedin-url-resolver`](https://github.com/mambalabsdev/mcp-domain-to-linkedin-url-resolver)
- [`@mambalabsdev/mcp-icp-fit-scorer`](https://github.com/mambalabsdev/mcp-icp-fit-scorer)

## Full actor documentation

For the complete input and output reference, pricing, and run history of each actor, see the Mamba Labs Apify Store page:

https://apify.com/mambalabs

## License

MIT

Built by Mamba Labs. https://apify.com/mambalabs
