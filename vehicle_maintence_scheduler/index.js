// vehicle_maintence_scheduler/index.js
const express = require("express");
const { Log } = require("../logging_middleware");
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const app = express();
const PORT = process.env.PORT || 3001;
const BASE_URL = "http://20.207.122.201/evaluation-service";

// Build auth headers fresh each request so token is always current
function getHeaders() {
  return {
    "Authorization": `Bearer ${process.env.ACCESS_TOKEN}`,
    "Content-Type": "application/json"
  };
}

/**
 * 0/1 Knapsack — O(n * W) time, O(W) space
 * Picks subset of tasks that maximises total Impact without exceeding capacity hours
 */
function knapsack(tasks, capacity) {
  const dp     = new Array(capacity + 1).fill(0);
  const chosen = new Array(capacity + 1).fill(null).map(() => []);

  for (const { Duration, Impact, TaskID } of tasks) {
    // Traverse backwards so each task is used at most once
    for (let w = capacity; w >= Duration; w--) {
      const withItem = dp[w - Duration] + Impact;
      if (withItem > dp[w]) {
        dp[w]     = withItem;
        chosen[w] = [...chosen[w - Duration], TaskID];
      }
    }
  }

  return { maxImpact: dp[capacity], selectedTasks: chosen[capacity] };
}

// ─── GET /schedule/:depotId ────────────────────────────────────────────────
app.get("/schedule/:depotId", async (req, res) => {
  const { depotId } = req.params;
  await Log("backend", "info", "handler", `Schedule request for depot ${depotId}`);

  try {
    await Log("backend", "debug", "service", "Fetching depots");
    const depotRes  = await fetch(`${BASE_URL}/depots`, { headers: getHeaders() });

    if (!depotRes.ok) {
      const txt = await depotRes.text();
      await Log("backend", "error", "service", `Depots API error ${depotRes.status}: ${txt}`);
      return res.status(502).json({ error: "Failed to fetch depots", detail: txt });
    }

    const depotData = await depotRes.json();
    const depot     = depotData.depots.find(d => d.ID == depotId);

    if (!depot) {
      await Log("backend", "warn", "handler", `Depot ${depotId} not found`);
      return res.status(404).json({ error: "Depot not found" });
    }

    const capacity = depot.MechanicHours;
    await Log("backend", "info", "service", `Depot ${depotId}: ${capacity} mechanic-hours budget`);

    await Log("backend", "debug", "service", "Fetching vehicles");
    const vehicleRes  = await fetch(`${BASE_URL}/vehicles`, { headers: getHeaders() });

    if (!vehicleRes.ok) {
      const txt = await vehicleRes.text();
      await Log("backend", "error", "service", `Vehicles API error ${vehicleRes.status}: ${txt}`);
      return res.status(502).json({ error: "Failed to fetch vehicles", detail: txt });
    }

    const vehicleData = await vehicleRes.json();
    const tasks       = vehicleData.vehicles;

    await Log("backend", "info", "service", `${tasks.length} tasks available, running knapsack`);

    const { maxImpact, selectedTasks } = knapsack(tasks, capacity);

    await Log("backend", "info", "service",
      `Knapsack done: ${selectedTasks.length} tasks selected, impact=${maxImpact}`);

    const result = {
      depotId:            depot.ID,
      mechanicHoursBudget: capacity,
      totalImpactScore:   maxImpact,
      selectedTaskCount:  selectedTasks.length,
      selectedTasks
    };

    await Log("backend", "info", "handler", `Responding with schedule for depot ${depotId}`);
    return res.json(result);

  } catch (err) {
    await Log("backend", "error", "handler", `Unexpected error for depot ${depotId}: ${err.message}`);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─── GET /schedule  (all depots) ──────────────────────────────────────────
app.get("/schedule", async (req, res) => {
  await Log("backend", "info", "handler", "Schedule request for all depots");

  try {
    await Log("backend", "debug", "service", "Fetching all depots");
    const depotRes = await fetch(`${BASE_URL}/depots`, { headers: getHeaders() });

    if (!depotRes.ok) {
      const txt = await depotRes.text();
      await Log("backend", "error", "service", `Depots API error ${depotRes.status}: ${txt}`);
      return res.status(502).json({ error: "Failed to fetch depots", detail: txt });
    }

    const depotData = await depotRes.json();

    await Log("backend", "debug", "service", "Fetching all vehicles");
    const vehicleRes = await fetch(`${BASE_URL}/vehicles`, { headers: getHeaders() });

    if (!vehicleRes.ok) {
      const txt = await vehicleRes.text();
      await Log("backend", "error", "service", `Vehicles API error ${vehicleRes.status}: ${txt}`);
      return res.status(502).json({ error: "Failed to fetch vehicles", detail: txt });
    }

    const vehicleData = await vehicleRes.json();
    const tasks       = vehicleData.vehicles;

    await Log("backend", "info", "service",
      `Scheduling ${depotData.depots.length} depots with ${tasks.length} available tasks`);

    const results = depotData.depots.map(depot => {
      const { maxImpact, selectedTasks } = knapsack(tasks, depot.MechanicHours);
      return {
        depotId:            depot.ID,
        mechanicHoursBudget: depot.MechanicHours,
        totalImpactScore:   maxImpact,
        selectedTaskCount:  selectedTasks.length,
        selectedTasks
      };
    });

    await Log("backend", "info", "handler", "All depot schedules computed");
    return res.json({ depots: results });

  } catch (err) {
    await Log("backend", "fatal", "handler", `Fatal error in schedule-all: ${err.message}`);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Start server ──────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  await Log("backend", "info", "config", `Vehicle scheduler started on port ${PORT}`);
  console.log(`\n✅ Vehicle Maintenance Scheduler running at http://localhost:${PORT}`);
  console.log(`   GET http://localhost:${PORT}/schedule          → all depots`);
  console.log(`   GET http://localhost:${PORT}/schedule/:depotId → single depot\n`);
});