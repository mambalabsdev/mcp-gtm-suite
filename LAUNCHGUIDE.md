# Mamba Labs GTM Suite MCP Server

## Tagline
21 account intelligence tools in one MCP server: identity, enrichment, signals, and ICP scoring.

## Description
One MCP server that exposes the Mamba Labs GTM Suite. Install a single package and your MCP client gets 21 account intelligence tools, each wrapping a dedicated Mamba Labs actor on Apify and returning Clay-ready flat JSON.

The tools cover the full go to market workflow: resolve a company's identity, enrich the account, detect buying signals, score fit against your ideal customer profile, and push the accounts that qualify into a sequencer. Every tool is also published as its own standalone MCP server, so you can install the whole suite or only the pieces you need.

The package is a thin stdio client. Each call starts the actor run, polls it until it finishes, and reads the dataset. A run is allowed 1,800 seconds. If the run is still going when the call stops waiting, the call returns the run ID and an Apify Console link instead of a timeout, so the result is never lost. `push_leads_to_sequencer` is the only tool that writes: it adds leads to your campaign unless `dry_run` is true. It is built for revenue teams, GTM engineers, and agencies who research and qualify accounts from an AI client.

## Setup Requirements
- `APIFY_TOKEN` (required): Your Apify API token. Every tool call runs the matching actor on your Apify account and is billed there. https://console.apify.com/account/integrations

## Category
Business Tools

## Features
- 21 tools in one package, one Apify actor behind each tool
- Resolve a company name, domain, and LinkedIn URL into one canonical identity with confidence scores
- Enrich a domain into employee band, industry, HQ, founded year, revenue, logo, and description
- Map a domain to its LinkedIn, X, Instagram, Facebook, and YouTube accounts and follower counts
- Resolve a domain or company name to a LinkedIn company URL
- Detect GTM hiring activity from career pages and scan job boards for roles in any category
- Detect CRM, sequencer, and marketing automation tools on a company's site
- Scan news and PR wires for funding, executive moves, launches, and acquisitions
- Monitor a domain and return only what changed since the last run
- Determine whether a company declares, deploys, or charges for AI
- Fingerprint cold outbound infrastructure and lookalike sending domains
- Track how much long form content a company publishes per month and the trend
- Combine hiring and tech stack signals into one composite score
- Score a company against your ideal customer profile
- Resolve a domain to its registered legal entity in Companies House, GLEIF, or SEC EDGAR
- Classify a job title into department, seniority, and a sortable rank by deterministic rule
- Audit whether an AI agent can read a site and what the site's policy says about it
- List the third party conferences a company publicly says it attends
- Find the companies that won work in a public award register
- Capture recent LinkedIn posts and their public commenters, with no login
- Push qualified leads to a sequencer, with a dry run mode
- Start and poll execution, so a long run is not cut off at 300 seconds
- Flat, Clay-ready JSON output
- Runs locally through npx with one environment variable

## Getting Started
- "Profile stripe.com: firmographics, hiring signals, tech stack, and an overall GTM score."
- "Resolve the canonical identity for Deel, then enrich its firmographics and social presence."
- "Find figma.com's LinkedIn URL, then score it against my ICP."
- "Any funding or exec moves at openai.com recently, and what CRM do they use?"
- "What changed at datadoghq.com since last week?"
- Tool: resolve_company_identity: Reconcile name, domain, and LinkedIn URL into one canonical identity.
- Tool: enrich_company_firmographics: Enrich a domain into structured firmographics.
- Tool: map_company_social_presence: Map a domain to social accounts and follower counts.
- Tool: resolve_linkedin_url: Resolve a domain or name to a LinkedIn company URL.
- Tool: scan_gtm_hiring_signals: Detect GTM hiring activity from career pages.
- Tool: detect_gtm_tech_stack: Detect CRM, sequencer, and marketing automation tools.
- Tool: scan_job_board_keywords: Scan job boards for roles in any category.
- Tool: get_funding_press_signals: Scan news and PR wires for funding and company events.
- Tool: get_company_changes: Return what changed at a domain since the last run.
- Tool: detect_ai_tooling: Determine whether a company declares, deploys, or charges for AI.
- Tool: fingerprint_outbound_infrastructure: Detect cold outbound stack and lookalike sending domains.
- Tool: track_publication_cadence: Measure long form publishing rate and trend.
- Tool: aggregate_gtm_signals: Combine hiring and tech stack signals into one score.
- Tool: score_icp_fit: Score a company against your ideal customer profile.
- Tool: resolve_legal_entity: Resolve a domain to its registered legal entity.
- Tool: classify_contact: Turn a job title into department, seniority, and rank.
- Tool: audit_agent_accessibility: Check whether an AI agent can read a site.
- Tool: map_company_event_presence: List the conferences a company says it attends.
- Tool: monitor_public_awards: List the winners in a public award register.
- Tool: capture_linkedin_posts_and_commenters: Capture recent posts and their public commenters.
- Tool: push_leads_to_sequencer: Add leads to a sequencer campaign; set `dry_run` to preview.

## Tags
gtm, account intelligence, sales intelligence, company enrichment, firmographics, buying signals, hiring signals, tech stack detection, funding signals, icp scoring, lead scoring, company identity, linkedin, social presence, legal entity, contact classification, outbound, sequencer, revops, abm, clay, apify, b2b data, prospecting, account research

## Documentation URL
https://github.com/mambalabsdev/mcp-gtm-suite#readme

## Health Check URL
Not applicable. This is a local stdio server run through npx.
