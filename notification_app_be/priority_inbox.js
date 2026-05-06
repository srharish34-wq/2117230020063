// notification_app_be/priority_inbox.js
const { Log } = require("../logging_middleware");
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const NOTIF_URL = "http://20.207.122.201/evaluation-service/notifications";

// Priority weights: Placement > Result > Event
const WEIGHT = { Placement: 3, Result: 2, Event: 1 };

/**
 * Min-Heap storing the top-N highest priority notifications.
 * Score = weight * 1e12 + unix_ms  →  type wins first, then recency.
 */
class MinHeap {
  constructor() { this.heap = []; }

  _score(item) {
    const ts = new Date(item.Timestamp).getTime();
    return (WEIGHT[item.Type] || 0) * 1e12 + ts;
  }

  push(item) {
    this.heap.push(item);
    this._bubbleUp(this.heap.length - 1);
  }

  pop() {
    if (this.heap.length === 0) return null;
    const top  = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  peek() { return this.heap[0]; }
  size() { return this.heap.length; }

  _bubbleUp(i) {
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this._score(this.heap[parent]) > this._score(this.heap[i])) {
        [this.heap[parent], this.heap[i]] = [this.heap[i], this.heap[parent]];
        i = parent;
      } else break;
    }
  }

  _sinkDown(i) {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this._score(this.heap[l]) < this._score(this.heap[smallest])) smallest = l;
      if (r < n && this._score(this.heap[r]) < this._score(this.heap[smallest])) smallest = r;
      if (smallest !== i) {
        [this.heap[smallest], this.heap[i]] = [this.heap[i], this.heap[smallest]];
        i = smallest;
      } else break;
    }
  }
}

/**
 * Returns top N notifications sorted highest-priority first.
 * O(m log N) where m = total notifications.
 */
function getTopN(notifications, n) {
  const heap = new MinHeap();
  for (const notif of notifications) {
    if (heap.size() < n) {
      heap.push(notif);
    } else if (heap._score(notif) > heap._score(heap.peek())) {
      heap.pop();
      heap.push(notif);
    }
  }
  // Drain heap in ascending order then reverse → descending (best first)
  const result = [];
  while (heap.size() > 0) result.unshift(heap.pop());
  return result;
}

async function main() {
  const token = process.env.ACCESS_TOKEN;
  if (!token) {
    console.error("❌ ACCESS_TOKEN not set in .env");
    process.exit(1);
  }

  await Log("backend", "info", "service", "Starting priority inbox computation");

  const res = await fetch(NOTIF_URL, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  });

  if (!res.ok) {
    const txt = await res.text();
    await Log("backend", "error", "service", `Notifications API error ${res.status}: ${txt}`);
    throw new Error(`API returned ${res.status}: ${txt}`);
  }

  const data          = await res.json();
  const notifications = data.notifications;

  await Log("backend", "info", "service", `Fetched ${notifications.length} notifications`);

  const N   = parseInt(process.env.TOP_N || "10", 10);
  const top = getTopN(notifications, N);

  await Log("backend", "info", "service", `Top ${N} notifications selected`);

  console.log(`\n${"=".repeat(55)}`);
  console.log(`  Top ${N} Priority Notifications`);
  console.log(`${"=".repeat(55)}`);
  top.forEach((n, i) => {
    const pad = String(i + 1).padStart(2, " ");
    console.log(`${pad}. [${n.Type.padEnd(9)}] ${n.Message.padEnd(30)} ${n.Timestamp}`);
  });
  console.log(`${"=".repeat(55)}\n`);

  return top;
}

main().catch(async (err) => {
  await Log("backend", "fatal", "service", `Priority inbox failed: ${err.message}`);
  console.error("❌ Error:", err.message);
  process.exit(1);
});