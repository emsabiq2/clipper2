import {
  configSummary,
  getRecentRuns,
  getRunJobs,
  methodAllowed,
  readState,
  requireAuth,
  sendJson
} from "./_utils.js";

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  if (!requireAuth(req, res)) return;

  try {
    const [state, recentRuns] = await Promise.all([readState(), getRecentRuns()]);
    const latestRun = recentRuns[0] || null;

    let activeRun = null;
    if (latestRun) {
      const isLive = latestRun.status === "in_progress" || latestRun.status === "queued";
      const liveJobs = isLive ? await getRunJobs(latestRun.id) : [];
      activeRun = buildActiveRun(latestRun, liveJobs);
    }

    sendJson(res, 200, {
      config: configSummary(),
      activeRun,
      recentRuns,
      themes: state.themes || [],
      videos: state.videos || [],
      prompts: state.prompts || [],
      jobs: state.jobs || [],
      history: state.history || []
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

function buildActiveRun(run, liveJobs) {
  const allSteps = liveJobs.flatMap((job) =>
    (job.steps || []).map((step) => ({ ...step, jobName: job.name }))
  );
  const total = allSteps.length;
  const completed = allSteps.filter((s) => s.status === "completed").length;
  const inProgress = allSteps.filter((s) => s.status === "in_progress");
  const progress = total ? Math.round((completed / total) * 100) : null;

  const status =
    run.status === "in_progress" || run.status === "queued"
      ? "running"
      : run.conclusion || run.status;

  const sortedSteps = [...allSteps].sort((a, b) =>
    String(a.started_at || "").localeCompare(String(b.started_at || ""))
  );

  const stepLogs = sortedSteps
    .filter((step) => step.status !== "queued" && step.started_at)
    .flatMap((step) => {
      const lines = [];
      lines.push({
        at: step.started_at,
        level: "running",
        text: `${step.jobName} -> ${step.name}`
      });
      if (step.status === "completed") {
        const seconds =
          step.completed_at && step.started_at
            ? Math.max(0, Math.round((new Date(step.completed_at) - new Date(step.started_at)) / 1000))
            : null;
        const failed = step.conclusion === "failure" || step.conclusion === "cancelled";
        lines.push({
          at: step.completed_at || step.started_at,
          level: failed ? "error" : "done",
          text:
            `${step.jobName} -> ${step.name} ${step.conclusion || "done"}` +
            (seconds !== null ? ` (${seconds}s)` : "")
        });
      }
      return lines;
    });

  const headerLog = {
    at: run.created_at,
    level: "system",
    text: `${run.name || "Workflow"} ${run.status}${run.conclusion ? `/${run.conclusion}` : ""}: ${run.html_url}`
  };

  const logs = [headerLog, ...stepLogs];

  const currentStep = inProgress[0] || null;
  const detail = currentStep
    ? `Sedang: ${currentStep.jobName} -> ${currentStep.name}`
    : status === "running"
      ? "Workflow di-trigger, menunggu runner."
      : run.display_title || run.html_url;

  return {
    id: String(run.id),
    name: run.name || "Workflow",
    title: run.display_title || "",
    branch: run.head_branch || "",
    status,
    conclusion: run.conclusion || "",
    startedAt: run.created_at,
    finishedAt: run.status === "completed" ? run.updated_at : "",
    htmlUrl: run.html_url,
    detail,
    progress,
    totalSteps: total,
    completedSteps: completed,
    jobs: liveJobs,
    logs,
    error: run.conclusion === "failure" ? "GitHub Actions gagal. Buka link run untuk detail." : ""
  };
}
