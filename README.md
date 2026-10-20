# Mamba Labs GTM Suite MCP Server

[![Smithery](https://smithery.ai/badge/mambabuilt/mcp-gtm-suite)](https://smithery.ai/servers/mambabuilt/mcp-gtm-suite) [![Glama score](https://glama.ai/mcp/servers/mambalabsdev/mcp-gtm-suite/badges/score.svg)](https://glama.ai/mcp/servers/mambalabsdev/mcp-gtm-suite) [![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dcom.mambabuilt%252Fmcp-gtm-suite%26limit%3D1&query=%24.servers%5B0%5D._meta%5B%22io.modelcontextprotocol.registry%2Fofficial%22%5D.status&label=mcp%20registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=com.mambabuilt/mcp-gtm-suite&limit=1) [![npm version](https://img.shields.io/npm/v/@mambalabsdev/mcp-gtm-suite)](https://www.npmjs.com/package/@mambalabsdev/mcp-gtm-suite) [![npm downloads](https://img.shields.io/npm/dm/@mambalabsdev/mcp-gtm-suite)](https://www.npmjs.com/package/@mambalabsdev/mcp-gtm-suite) [![license](https://img.shields.io/github/license/mambalabsdev/mcp-gtm-suite)](https://github.com/mambalabsdev/mcp-gtm-suite/blob/main/LICENSE) [![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-blue)](https://mcpservers.org/servers/mambalabsdev/mcp-gtm-suite)

<a href="https://mcprush.com/to/gtm-suite-mcp?ref=badge"><img width="380" height="200" src="https://mcprush.com/badge/gtm-suite-mcp/card.svg" alt="Gtm Suite MCP server" /></a>

One MCP server that exposes the Mamba Labs GTM Suite. Install a single package and get all twenty one account-intelligence tools in your MCP client, each wrapping a Mamba Labs actor on Apify and returning Clay-ready flat JSON.

## What's Inside

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Example prompts](#example-prompts)
- [Tools and inputs](#tools-and-inputs)
- [Pricing](#pricing)
- [How each call runs](#how-each-call-runs)
- [Full actor documentation](#full-actor-documentation)
- [Mamba Labs GTM Suite](#mamba-labs-gtm-suite)
- [License](#license)

## What it does

This server gives an AI client twenty one account-intelligence tools in one place, covering the full GTM workflow: resolve identity, enrich the account, detect buying signals, score fit, and push the survivors into a sequencer.

**Identity and enrichment**

- `resolve_company_identity`: reconcile name, domain, and LinkedIn URL into one canonical identity with confidence scores
- `enrich_company_firmographics`: enrich a domain into employee band, industry, HQ, founded year, revenue, logo, and description
- `map_company_social_presence`: map a domain to LinkedIn, X, Instagram, Facebook, and YouTube URLs and follower counts
- `resolve_linkedin_url`: resolve a domain or name to a LinkedIn company URL

**Signals**

- `scan_gtm_hiring_signals`: detect GTM hiring activity from career pages
- `detect_gtm_tech_stack`: detect CRM, sequencer, and marketing automation tools
- `scan_job_board_keywords`: scan job boards for roles in any category
- `get_funding_press_signals`: scan news and PR wires for funding, exec moves, launches, and acquisitions
- `get_company_changes`: monitor a domain and return only what changed since the last run; choose the sources to watch and a severity floor
- `detect_ai_tooling`: determine whether a company declares, deploys, or charges for AI
- `fingerprint_outbound_infrastructure`: determine whether a company runs cold outbound, on what stack, and from which lookalike sending domains
- `track_publication_cadence`: how much long-form work a company publishes per month, and whether that rate is rising or falling

**Scoring**

- `aggregate_gtm_signals`: combine hiring and tech-stack signals, plus funding, events, or workplace on request, into one composite score
- `score_icp_fit`: score a company against your ideal customer profile

**Entity and record resolution**

- `resolve_legal_entity`: resolve a domain to its registered legal entity in Companies House, GLEIF or SEC EDGAR
- `classify_contact`: turn a job title into a department, a seniority level and a sortable rank, by deterministic rule

**Reach and readiness**

- `audit_agent_accessibility`: whether an AI agent can read a site, and what the site's policy says about it
- `map_company_event_presence`: the third-party conferences a company publicly says it attends
- `monitor_public_awards`: the companies that won work in a public award register, one row per winner
- `capture_linkedin_posts_and_commenters`: the LinkedIn posts a search engine has indexed for profiles and company pages, with no request to LinkedIn (commenters removed 2026-10-12)

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

Get your token at https://console.apify.com/account/integrations, paste it in, and restart Claude Desktop. All twenty one tools will be available.

## Prerequisites

- Node.js 18 or newer
- An Apify account with an API token

## Example prompts

- "Profile stripe.com: firmographics, hiring signals, tech stack, and an overall GTM score."
- "Resolve the canonical identity for Deel, then enrich its firmographics and social presence."
- "Find figma.com's LinkedIn URL, then score it against my ICP."
- "Any funding or exec moves at openai.com recently, and what CRM do they use?"
- "What changed at datadoghq.com since last week?"

## Tools and inputs

Each tool maps to one Apify actor. Every input each tool accepts is listed below, generated from the server's own tool list. Where a tool marks nothing required, it still needs one identifier: the tool says which when you call it without one.

- `scan_gtm_hiring_signals` (8 inputs): required `domain`; optional `role_filter`, `ats_slug`, `mode`, `include_role_details`, `previous_gtm_role_count`, `previous_run_date`, `max_charge_usd`
- `detect_gtm_tech_stack` (7 inputs): optional `domain`, `company_domain`, `url`, `crawl_additional_pages`, `skipCache`, `technologies`, `max_charge_usd`
- `aggregate_gtm_signals` (5 inputs): required `company_domain`; optional `include_summary`, `explain_mode`, `sources`, `max_charge_usd`
- `scan_job_board_keywords` (7 inputs): required `company_domain`, `role_categories`; optional `custom_keywords`, `enable_fallback`, `previous_roles_detected`, `previous_run_date`, `max_charge_usd`
- `resolve_linkedin_url` (6 inputs): optional `company_domain`, `company_name`, `includeFirmographics`, `skipCache`, `minConfidenceScore`, `max_charge_usd`
- `score_icp_fit` (44 inputs): required `company_domain`; optional `company_name`, `template`, `scoring_config`, `icp_description`, `llm_api_key`, `llm_provider`, `fetch_signals`, `include_explanation`, `tier_thresholds`, `funded_within_days`, `min_score_to_output`, `previous_score`, `gtm_hiring_signal`, `gtm_role_count`, `uses_hubspot`, `uses_salesforce`, `uses_clay`, `crm_detected`, `seq_tool_detected`, `tech_stack`, `headcount`, `headcount_min`, `headcount_max`, `headcount_in_range`, `employee_band`, `revenue_estimate`, `hq_location`, `founded_year`, `recently_funded`, `last_funding_date`, `latest_funding_date`, `latest_funding_amount`, `funding_stage`, `industry`, `industry_match`, `target_industries`, `social_platforms_found`, `total_followers`, `has_linkedin`, `has_twitter`, `job_count`, `keyword_match_count`, `max_charge_usd`
- `resolve_company_identity` (6 inputs): optional `company_name`, `domain`, `linkedin_url`, `skipCache`, `minLinkedinConfidence`, `max_charge_usd`
- `enrich_company_firmographics` (6 inputs): optional `domain`, `company_name`, `domains`, `batchSize`, `skipCache`, `max_charge_usd`
- `map_company_social_presence` (6 inputs): optional `company_domain`, `company_name`, `platforms`, `includeFollowerCounts`, `skipCache`, `max_charge_usd`
- `get_funding_press_signals` (5 inputs): required `domain`; optional `company_name`, `signal_types`, `lookback_days`, `max_charge_usd`
- `get_company_changes` (7 inputs): required `domain`; optional `company_name`, `previous_snapshot`, `sub_actor_timeout_secs`, `sources`, `min_severity`, `max_charge_usd`
- `detect_ai_tooling` (7 inputs): optional `domain`, `domains`, `check_pricing`, `skipCache`, `request_timeout_ms`, `vendors`, `max_charge_usd`
- `fingerprint_outbound_infrastructure` (10 inputs): optional `domain`, `domains`, `scan_sending_domains`, `sending_domain_depth`, `check_deliverability`, `skipCache`, `max_sending_domain_probes`, `request_timeout_ms`, `dns_timeout_ms`, `max_charge_usd`
- `track_publication_cadence` (9 inputs): optional `domain`, `domains`, `max_pages_to_date`, `domain_time_budget_ms`, `skipCache`, `page_concurrency`, `max_sitemap_fetches`, `request_timeout_ms`, `max_charge_usd`
- `push_leads_to_sequencer` (11 inputs): required `sequencer`, `campaign_id`; optional `api_key`, `leads`, `dataset_id`, `min_icp_score`, `deduplicate`, `dry_run`, `field_mapping`, `custom_variables`, `max_charge_usd`
- `audit_agent_accessibility` (6 inputs): required `domain`; optional `check_endpoints`, `check_structured_data`, `skipCache`, `checks`, `max_charge_usd`
- `classify_contact` (9 inputs): required `job_title`; optional `full_name`, `company_domain`, `verify_position`, `use_llm_fallback`, `llm_provider`, `llm_model`, `skipCache`, `max_charge_usd`
- `map_company_event_presence` (7 inputs): required `domain`; optional `company_name`, `years`, `include_own_events`, `max_queries`, `skipCache`, `max_charge_usd`
- `resolve_legal_entity` (9 inputs): required `domain`, `sec_requester_name`, `sec_requester_email`; optional `legal_name_hint`, `jurisdiction_hint`, `match_strictness`, `validate_vat`, `skipCache`, `max_charge_usd`
- `monitor_public_awards` (8 inputs): required `register`; optional `window_days`, `min_award_value`, `max_entities`, `exclude_government_recipients`, `resolve_domains`, `domain_confidence_floor`, `max_charge_usd`
- `capture_linkedin_posts_and_commenters` (4 inputs): optional `profile_urls`, `company_urls`, `posted_since`, `max_charge_usd`.

Every tool also accepts `max_charge_usd`, an optional spending cap in USD for that call: the actor stops before any charge that would take the run past it and keeps every row already charged.

`push_leads_to_sequencer` is the only tool here that writes: it adds leads to your campaign unless `dry_run` is true.

## Pricing

Each tool runs its actor on your own Apify account and is billed there, pay per event. Every run also carries Apify's actor start event at $0.00005 per GB of memory. Prices below are read from each actor's live pricing record on 2026-10-16; the Apify page of each actor carries the current price.

| Tool | Events and price per event (USD) |
| --- | --- |
| `scan_gtm_hiring_signals` | `apify-default-dataset-item` $0.05 on the Free plan, down to $0.0425 on higher Apify plans |
| `detect_gtm_tech_stack` | `apify-default-dataset-item` $0.015 on the Free plan, down to $0.0128 on higher Apify plans |
| `aggregate_gtm_signals` | `apify-default-dataset-item` $0.055 on the Free plan, down to $0.0385 on higher Apify plans |
| `scan_job_board_keywords` | `apify-default-dataset-item` $0.05 on the Free plan, down to $0.0425 on higher Apify plans |
| `resolve_linkedin_url` | `apify-default-dataset-item` $0.006 on the Free plan, down to $0.0051 on higher Apify plans |
| `score_icp_fit` | `apify-default-dataset-item` $0.05 on the Free plan, down to $0.0425 on higher Apify plans |
| `resolve_company_identity` | `apify-default-dataset-item` $0.007 on the Free plan, down to $0.00595 on higher Apify plans |
| `enrich_company_firmographics` | `apify-default-dataset-item` $0.004 on the Free plan, down to $0.0034 on higher Apify plans |
| `map_company_social_presence` | `apify-default-dataset-item` $0.015 on the Free plan, down to $0.0128 on higher Apify plans |
| `get_funding_press_signals` | `apify-default-dataset-item` $0.03 on the Free plan, down to $0.0255 on higher Apify plans |
| `get_company_changes` | `apify-default-dataset-item` $0.01 on the Free plan, down to $0.0085 on higher Apify plans; `change-source-resolved` $0.01 on the Free plan, down to $0.0085 on higher Apify plans |
| `detect_ai_tooling` | `actor-start` $0.00005; `domain-analyzed` $0.003 on the Free plan, down to $0.00255 on higher Apify plans |
| `fingerprint_outbound_infrastructure` | `actor-start` $0.00005; `domain-analyzed` $0.004 on the Free plan, down to $0.0034 on higher Apify plans |
| `track_publication_cadence` | `actor-start` $0.00005; `domain-analyzed` $0.004 on the Free plan, down to $0.0034 on higher Apify plans |
| `push_leads_to_sequencer` | `lead-pushed` $0.01 on the Free plan, down to $0.0085 on higher Apify plans |
| `audit_agent_accessibility` | `domain-analyzed` $0.005 on the Free plan, down to $0.00425 on higher Apify plans |
| `classify_contact` | `contact-classified` $0.003 on the Free plan, down to $0.00255 on higher Apify plans |
| `map_company_event_presence` | `company-analyzed` $0.005 on the Free plan, down to $0.00425 on higher Apify plans |
| `resolve_legal_entity` | `domain-resolved` $0.007 on the Free plan, down to $0.00595 on higher Apify plans |
| `monitor_public_awards` | `award-winner-found` $0.005 on the Free plan, down to $0.00425 on higher Apify plans |
| `capture_linkedin_posts_and_commenters` | `post-collected` $0.002 on the Free plan, down to $0.0017 on higher Apify plans |

A pricing change takes effect on 2026-10-26 for company-firmographic-enricher, company-identity-resolver, domain-to-linkedin-url-resolver: the charge moves to a `result` event. Check the actor's Apify page after that date.

## How each call runs

Each call starts the actor run, polls it until it finishes, then reads the dataset. A run is allowed 1,800 seconds. If the run is still going when this call stops waiting, the call returns the run id and a console link instead of a timeout, so the result is never lost.

## Full actor documentation

For the complete input and output reference, pricing, and run history of each actor, see the Mamba Labs Apify Store page:

https://apify.com/mambalabs

---

## Mamba Labs GTM Suite

This is the umbrella server for the **Mamba Labs GTM Suite**: twenty one account-intelligence tools for go-to-market signal intelligence, each backed by a dedicated Apify actor and also published as its own standalone MCP server. The Mamba Labs fleet has 62 public actors; the brand presence mappers, the influencer suite, Expert Witness Directory, and the other actors outside this list are available as their own servers under [@mambalabsdev on npm](https://www.npmjs.com/org/mambalabsdev).

| Tool | Actor | Immutable Actor ID |
|---|---|---|
| `scan_gtm_hiring_signals` | [GTM Hiring Signal Scraper](https://apify.com/mambalabs/gtm-hiring-signal-scraper) | `D7O1SA2EqwHGsGr1P` |
| `detect_gtm_tech_stack` | [Tech Stack Signal Detector](https://apify.com/mambalabs/gtm-tech-stack-signal-scraper) | `qyd7nNyqFPelQViBx` |
| `aggregate_gtm_signals` | [GTM Signals Aggregator](https://apify.com/mambalabs/b2b-buying-signals-hiring-tech-stack-intent-for-clay) | `xKdRfnfFNkdMpFuNs` |
| `scan_job_board_keywords` | [Job Board Keyword Signal Scanner](https://apify.com/mambalabs/job-board-keyword-signal-scanner) | `4DvqpvhMR74NLcDDY` |
| `resolve_linkedin_url` | [Domain to LinkedIn URL Resolver](https://apify.com/mambalabs/domain-to-linkedin-url-resolver) | `3HtnSaqPHOg1Qg5gx` |
| `score_icp_fit` | [ICP Fit Scorer](https://apify.com/mambalabs/icp-account-lead-scoring-fit-scorer-0-100-for-clay) | `W161DT8W4kW55dMFh` |
| `resolve_company_identity` | [Company Identity Resolver](https://apify.com/mambalabs/company-identity-resolver) | `lr8fTRAmZCBZmuwwh` |
| `enrich_company_firmographics` | [Company Firmographic Enricher](https://apify.com/mambalabs/company-firmographic-enricher) | `YlUtLWjfPpqykmB8g` |
| `map_company_social_presence` | [Company Social Presence Mapper](https://apify.com/mambalabs/company-social-presence-mapper) | `4k6CCemkgBDz18m2h` |
| `get_funding_press_signals` | [Funding and Press Signal Scanner](https://apify.com/mambalabs/funding-press-signal-scanner) | `FS13X6dhQVgX3XOM6` |
| `get_company_changes` | [Company Change Event Feed](https://apify.com/mambalabs/company-change-event-feed) | `oX44rS0fkEJ3rXLWe` |
| `detect_ai_tooling` | [AI Tooling Detector](https://apify.com/mambalabs/ai-tooling-detector) | `EwkHhmqiuJgRoVEbE` |
| `fingerprint_outbound_infrastructure` | [Outbound Stack Detector](https://apify.com/mambalabs/outbound-infrastructure-fingerprint) | `v43UJC8r7qW7cBSTG` |
| `track_publication_cadence` | [Publishing Frequency Tracker](https://apify.com/mambalabs/blog-publishing-frequency) | `TbLwaUUATdYb6wp4N` |
| `push_leads_to_sequencer` | [Sequencer Lead Push](https://apify.com/mambalabs/clay-to-instantly-smartlead-push) | `0Jv27VeWM5tSZQs9x` |
| `audit_agent_accessibility` | [Agent Accessibility Auditor](https://apify.com/mambalabs/agent-accessibility-auditor) | `anxbRv0lKrpQ1pnua` |
| `classify_contact` | [Contact Classifier](https://apify.com/mambalabs/contact-classifier) | `0lGSeYJmniXhGANnO` |
| `map_company_event_presence` | [Event Presence Index](https://apify.com/mambalabs/event-presence-index) | `WLhMy8fMDgsxdYxv5` |
| `resolve_legal_entity` | [Legal Entity Resolver](https://apify.com/mambalabs/legal-entity-resolver) | `KHFyPCDIx7CyqULYm` |
| `monitor_public_awards` | [Government Contract Award Monitor](https://apify.com/mambalabs/public-award-monitor) | `zhEtllASykOcx9hJ8` |
| `capture_linkedin_posts_and_commenters` | [LinkedIn Post Tracker](https://apify.com/mambalabs/linkedin-post-engager-capture) | `oiGLNPuaf5BRaz9K5` |

> The [Domain Deliverability Checker](https://apify.com/mambalabs/domain-deliverability-checker) actor is published as a standalone MCP server but is intentionally not bundled here: it audits email-sending infrastructure (SPF, DKIM, DMARC, blacklists) rather than account intelligence, so it sits outside this suite's scope.

> Built by [Mamba Labs](https://github.com/mambalabsdev) | [npm](https://www.npmjs.com/org/mambalabsdev) | [Apify Store](https://apify.com/mambalabs) | [mambabuilt.com](https://mambabuilt.com)

## License

MIT

Built by Mamba Labs. https://apify.com/mambalabs
