import { useEffect, useState } from "react";
import type { PublicSeries } from "../shared.js";

interface Analysis {
  primary: { completeBlocks: number; plannedBlocks: number; estimate: number | null; confidenceInterval95: [number, number] | null; missingOutcomeBounds: [number, number] | null; caveat: string };
}

export function ResearchSummary({ series }: { series: PublicSeries }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    if (!["completed", "stopped"].includes(series.status)) return () => controller.abort();
    void fetch(`/api/series/${encodeURIComponent(series.id)}/analysis`, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Could not load paired analysis.");
      const data = await response.json() as Analysis;
      if (!controller.signal.aborted) { setAnalysis(data); setError(""); }
    }).catch((reason: unknown) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Analysis unavailable."); });
    return () => controller.abort();
  }, [series.id, series.status, series.updatedAt]);
  if (!series.researchPlan) return null;
  const percentage = (n: number) => `${(100 * n).toFixed(1)} percentage points`;
  return <section className="identity-note" aria-label="Research interpretation">
    <h4>{series.researchPlan.title}</h4>
    <p>{series.researchPlan.question}</p>
    <p>Registered exploratory study · {series.researchPlan.comparison.kind === "same-model-control" ? "Same-model control" : "System comparison"}. Execution-qualified trials do not establish a validated capability benchmark.</p>
    <p>{series.researchPlan.blocks} matched blocks · {series.researchPlan.replicates} replicates · {series.slots.length} planned matches. Primary analysis uses first attempts; reruns remain separate evidence.</p>
    {analysis && <>
      <p>{analysis.primary.completeBlocks}/{analysis.primary.plannedBlocks} complete blocks · estimated contrast: {analysis.primary.estimate === null ? "not estimable" : percentage(analysis.primary.estimate)}.</p>
      <p>95% block-bootstrap interval: {analysis.primary.confidenceInterval95?.map(percentage).join(" to ") ?? "insufficient complete blocks"}.</p>
      <p>All-planned-block missing-outcome bounds: {analysis.primary.missingOutcomeBounds?.map(percentage).join(" to ") ?? "not available"}.</p>
      <p>{analysis.primary.caveat}</p>
    </>}
    {error && <p role="status">{error}</p>}
    <details><summary>Registered conditions and commitments</summary>
      {series.researchPlan.conditions.map((condition) => <p key={condition.id}>{condition.label}: {condition.gameId} / {condition.gameVersion} · {condition.rolePolicy} roles</p>)}
      <p>Plan commitment: <code>{series.planHash}</code></p><p>Challenge-root commitment: <code>{series.seedCommitment}</code></p>
      <p>Fixed sample; at most {series.researchPlan.maxSlotRetries} infrastructure rerun per slot. JSON export includes the raw analysis rows.</p>
    </details>
  </section>;
}
