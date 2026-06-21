# Mamba Labs GTM Suite MCP Server

[![Smithery](https://smithery.ai/badge/mambabuilt/mcp-gtm-suite)](https://smithery.ai/servers/mambabuilt/mcp-gtm-suite) [![Glama score](https://glama.ai/mcp/servers/mambalabsdev/mcp-gtm-suite/badges/score.svg)](https://glama.ai/mcp/servers/mambalabsdev/mcp-gtm-suite) [![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dcom.mambabuilt%252Fmcp-gtm-suite%26limit%3D1&query=%24.servers%5B0%5D._meta%5B%22io.modelcontextprotocol.registry%2Fofficial%22%5D.status&label=mcp%20registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=com.mambabuilt/mcp-gtm-suite&limit=1) [![npm version](https://img.shields.io/npm/v/@mambalabsdev/mcp-gtm-suite)](https://www.npmjs.com/package/@mambalabsdev/mcp-gtm-suite) [![npm downloads](https://img.shields.io/npm/dm/@mambalabsdev/mcp-gtm-suite)](https://www.npmjs.com/package/@mambalabsdev/mcp-gtm-suite) [![license](https://img.shields.io/github/license/mambalabsdev/mcp-gtm-suite)](https://github.com/mambalabsdev/mcp-gtm-suite/blob/main/LICENSE) [![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-blue)](https://mcpservers.org/servers/mambalabsdev/mcp-gtm-suite)

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

## Full actor documentation

For the complete input and output reference, pricing, and run history of each actor, see the Mamba Labs Apify Store page:

https://apify.com/mambalabs

---

## Mamba Labs GTM Suite

This is the umbrella server for the **Mamba Labs GTM Suite**, a fleet of eight specialized MCP servers for go-to-market signal intelligence, each backed by a dedicated Apify actor.

| Actor | Immutable Actor ID |
|---|---|
| [GTM Hiring Signal Scraper](https://console.apify.com/actors/D7O1SA2EqwHGsGr1P) | `D7O1SA2EqwHGsGr1P` |
| [GTM Tech Stack Signal Enrichment](https://console.apify.com/actors/qyd7nNyqFPelQViBx) | `qyd7nNyqFPelQViBx` |
| [GTM Signals Aggregator](https://console.apify.com/actors/xKdRfnfFNkdMpFuNs) | `xKdRfnfFNkdMpFuNs` |
| [Job Board Keyword Signal Scanner](https://console.apify.com/actors/4DvqpvhMR74NLcDDY) | `4DvqpvhMR74NLcDDY` |
| [Domain to LinkedIn URL Resolver](https://console.apify.com/actors/3HtnSaqPHOg1Qg5gx) | `3HtnSaqPHOg1Qg5gx` |
| [ICP Fit Scorer](https://console.apify.com/actors/W161DT8W4kW55dMFh) | `W161DT8W4kW55dMFh` |
| [Domain Deliverability Checker](https://console.apify.com/actors/0tVgxI7A6o9jMlxmc) | `0tVgxI7A6o9jMlxmc` |
| [Company Firmographic Enricher](https://console.apify.com/actors/YlUtLWjfPpqykmB8g) | `YlUtLWjfPpqykmB8g` |

> Built by [Mamba Labs](https://github.com/mambalabsdev) | [npm](https://www.npmjs.com/org/mambalabsdev) | [Apify Store](https://apify.com/mambabuilt)

## License

MIT

Built by Mamba Labs. https://apify.com/mambalabs
