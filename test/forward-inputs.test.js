import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Every input a tool declares must reach the actor's run input. A declared input
// that is never forwarded is accepted from the caller and silently ignored, which
// on the change feed meant a one source watch was billed for all five sources.

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

function session(requests, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", join(here, "mock-fetch.mjs"), join(repo, "build", "index.js")],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MAMBA_MCP_POLL_INTERVAL_MS: "5", APIFY_TOKEN: "test-token", ...env } },
    );
    const results = new Map();
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("timed out")); }, 60000);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      const lines = out.split("\n");
      out = lines.pop();
      for (const line of lines) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.id === "number" && msg.id >= 2) {
          results.set(msg.id, msg.result ?? msg.error);
          if (results.size === requests.length) {
            clearTimeout(timer);
            child.kill();
            resolve(requests.map((_, i) => results.get(i + 2)));
          }
        }
      }
    });
    const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "forward-test", version: "0.0.0" } } });
    send({ method: "notifications/initialized" });
    requests.forEach((r, i) => send({ id: i + 2, ...r }));
  });
}

function sample(schema) {
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf) return sample(schema.anyOf[0]);
  switch (schema.type) {
    case "array": return [sample(schema.items ?? { type: "string" })];
    case "number":
    case "integer": return schema.minimum ?? 20000;
    case "boolean": return true;
    case "object": return schema.additionalProperties?.type === "string" ? { k: "v" } : { k: 1 };
    default: return schema.pattern ? "70" : "example.com";
  }
}

// Inputs that are exclusive by design: the handler forwards one of the pair.
const EXCLUSIVE = { domain: "domains", dataset_id: "leads" };

test("every declared input reaches the actor run input", async () => {
  const [list] = await session([{ method: "tools/list", params: {} }], {});
  for (const tool of list.tools) {
    const declared = Object.keys(tool.inputSchema.properties ?? {});
    const args = Object.fromEntries(declared.map((k) => [k, sample(tool.inputSchema.properties[k])]));
    const variants = [args];
    for (const [k, other] of Object.entries(EXCLUSIVE)) {
      if (declared.includes(k) && declared.includes(other)) {
        const v = { ...args };
        delete v[other];
        variants.push(v);
      }
    }
    const forwarded = new Set();
    for (const v of variants) {
      const log = join(mkdtempSync(join(tmpdir(), "mcp-fw-")), "body.log");
      const [res] = await session([{ method: "tools/call", params: { name: tool.name, arguments: v } }], { MOCK_BODY_LOG: log });
      assert.ok(!res.isError, `${tool.name}: ${JSON.stringify(res)}`);
      assert.ok(existsSync(log), `${tool.name} started no run`);
      for (const line of readFileSync(log, "utf8").trim().split("\n")) Object.keys(JSON.parse(line)).forEach((k) => forwarded.add(k));
    }
    const dropped = declared.filter((k) => !forwarded.has(k));
    assert.deepEqual(dropped, [], `${tool.name} accepts but never forwards: ${dropped.join(", ")}`);
  }
});

test("get_company_changes forwards sources and min_severity", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "mcp-fw-")), "body.log");
  await session([{ method: "tools/call", params: { name: "get_company_changes", arguments: { domain: "example.com", sources: ["hiring"], min_severity: "high" } } }], { MOCK_BODY_LOG: log });
  const body = JSON.parse(readFileSync(log, "utf8").trim());
  assert.deepEqual(body.sources, ["hiring"]);
  assert.equal(body.min_severity, "high");
});
