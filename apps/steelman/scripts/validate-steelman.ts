import { spawn } from "node:child_process";

const PORT = Number(process.env.STEELMAN_PORT || 45210);
const BASE_URL = `http://127.0.0.1:${PORT}`;

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy");
}

async function main() {
  console.log("=== Steelman product-agent validation ===");
  const server = spawn("bun", ["src/server.ts"], {
    cwd: new URL("../server/", import.meta.url).pathname,
    env: { ...process.env, STEELMAN_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  try {
    await waitForHealth();
    console.log("[T1] server healthy");

    const thesis = "Bull thesis: AAPL deserves a higher multiple because on-device AI will create a supercycle and services ARPU acceleration.";
    const createRes = await fetch(`${BASE_URL}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ thesis }),
    });
    assert(createRes.status === 201, `run create returned ${createRes.status}`);
    const { run } = await createRes.json();
    assert(run.id, "run id exists");
    assert(run.obsUrl?.includes("product-steelman"), "obs link contains product pool");
    console.log(`[T2] run created: ${run.id}`);

    let snapshot: any;
    // Increase polling limit to up to 240 seconds to allow the real pi-rpc process
    // and LLM model sufficient time to boot, call tools, and emit final artifacts.
    for (let i = 0; i < 2400; i++) {
      const res = await fetch(`${BASE_URL}/api/runs/${run.id}`);
      snapshot = (await res.json()).run;
      if (snapshot.status === "done" && snapshot.artifacts.length >= 3) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    assert(snapshot.status === "done", `expected done, got ${snapshot.status}`);
    assert(snapshot.chat.some((m: any) => m.role === "assistant" && /@[a-zA-Z0-9_-]+/.test(m.text)), "assistant references an emitted artifact");
    assert(snapshot.artifacts.length >= 3, "at least three artifacts emitted");
    assert(snapshot.artifacts.every((a: any) => ["table", "bar-chart", "pie-chart", "text", "html", "trend", "scorecard", "risk-map"].includes(a.kind)), "valid artifact kinds emitted");
    console.log("[T3] real pi-rpc run produced chat refs and artifacts");

    const followRes = await fetch(`${BASE_URL}/api/runs/${run.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "What would change your mind?" }),
    });
    assert(followRes.ok, "follow-up accepted");
    console.log("[T4] follow-up route accepted");

    console.log("✓ Steelman validation passed");
  } finally {
    server.kill("SIGTERM");
  }
}

main().catch((err) => {
  console.error("❌ Steelman validation failed");
  console.error(err);
  process.exit(1);
});
