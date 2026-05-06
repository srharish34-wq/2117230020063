// logging_middleware/index.js
// Reusable logging package — POSTs to the evaluation server log API
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const LOG_API = "http://20.207.122.201/evaluation-service/logs";

const VALID_STACKS   = ["backend", "frontend"];
const VALID_LEVELS   = ["debug", "info", "warn", "error", "fatal"];
const VALID_PACKAGES = [
  // backend-only
  "cache", "controller", "cron_job", "db", "domain",
  "handler", "repository", "route", "service",
  // shared
  "auth", "config", "middleware", "utils",
  // frontend-only
  "api", "component", "hook", "page", "state", "style"
];

async function Log(stack, level, pkg, message) {
  if (!VALID_STACKS.includes(stack))   throw new Error(`Invalid stack: ${stack}`);
  if (!VALID_LEVELS.includes(level))   throw new Error(`Invalid level: ${level}`);
  if (!VALID_PACKAGES.includes(pkg))   throw new Error(`Invalid package: ${pkg}`);

  const token = process.env.ACCESS_TOKEN;
  if (!token) {
    console.error("[Logger] ACCESS_TOKEN not set — log not sent");
    return;
  }

  try {
    const res = await fetch(LOG_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({ stack, level, package: pkg, message })
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[Logger] API error ${res.status}: ${text}`);
      return;
    }

    const data = await res.json();
    return data;
  } catch (err) {
    // Never crash the app due to a logging failure
    console.error("[Logger] Failed to send log:", err.message);
  }
}

module.exports = { Log };