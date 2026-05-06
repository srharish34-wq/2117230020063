# Notification System Design

## Stage 1

### REST API Design

#### GET /notifications
Fetch all notifications for the logged-in student.

**Request Headers:**
```json
{ "Authorization": "Bearer <token>" }
```

**Response 200:**
```json
{
  "notifications": [
    {
      "id": "uuid",
      "type": "Placement | Event | Result",
      "message": "string",
      "timestamp": "2026-04-22T17:51:30",
      "isRead": false
    }
  ]
}
```

#### PATCH /notifications/:id/read
Mark a notification as read.

**Response 200:**
```json
{ "id": "uuid", "isRead": true }
```

#### GET /notifications/unread
Get count of unread notifications.

**Response 200:**
```json
{ "unreadCount": 12 }
```

#### Real-time Notifications
Use **WebSockets** (via Socket.io or native WS). On new notification, server emits a `notification` event to the student's socket room.

```json
// Server emits:
{ "event": "notification", "data": { "id": "...", "type": "Placement", "message": "Google hiring", "timestamp": "..." } }
```

---

## Stage 2

### Database Choice: PostgreSQL

**Why PostgreSQL:**
- Relational model fits structured notification data with foreign keys (studentID → students table)
- Supports efficient indexed queries on `studentID`, `isRead`, `createdAt`
- JSONB columns available for flexible metadata if needed
- Strong ACID guarantees prevent duplicate or lost notifications

**Schema:**
```sql
CREATE TABLE students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID REFERENCES students(id) ON DELETE CASCADE,
  type notification_type NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TYPE notification_type AS ENUM ('Placement', 'Event', 'Result');
```

**Problems as data volume grows:**
- Table scans become slow without indexes
- Unread queries across 5M rows degrade to seconds
- JOIN-heavy queries risk N+1 problems

**Solutions:**
- Composite index on `(student_id, is_read, created_at)`
- Partition table by month using PostgreSQL table partitioning
- Archive notifications older than 6 months to a cold storage table

**Queries:**
```sql
-- Fetch unread notifications for student
SELECT * FROM notifications
WHERE student_id = $1 AND is_read = false
ORDER BY created_at DESC;

-- Mark as read
UPDATE notifications SET is_read = true WHERE id = $1 AND student_id = $2;

-- Count unread
SELECT COUNT(*) FROM notifications WHERE student_id = $1 AND is_read = false;
```

---

## Stage 3

### Query Analysis

**Original query:**
```sql
SELECT * FROM notifications
WHERE studentID = 1042 AND isRead = false
ORDER BY createdAt DESC;
```

**Is this accurate?** Mostly yes — filters and sort are logically correct.

**Why is it slow?**
With 5,000,000 rows and no index, PostgreSQL does a full sequential scan. At 50,000 students, each query scans millions of rows to find one student's unread notifications.

**Computation cost:** O(n) per query = catastrophic at scale.

**Adding indexes on every column:** Bad advice. Indexes have write overhead — every INSERT/UPDATE rebuilds the index. Indexing rarely-filtered columns (like `message`) wastes disk and slows writes with no read benefit.

**Better fix:** A targeted composite index:
```sql
CREATE INDEX idx_notifications_student_read_date
ON notifications (studentID, isRead, createdAt DESC);
```
This makes the query O(log n + k) where k = matching rows.

**Query to find students with Placement notifications in last 7 days:**
```sql
SELECT DISTINCT student_id
FROM notifications
WHERE notification_type = 'Placement'
  AND created_at >= NOW() - INTERVAL '7 days';
```

---

## Stage 4

### Caching Strategy for Notification Fetches

**Problem:** DB overwhelmed by notifications being fetched on every page load.

**Strategy 1: Redis Cache with TTL**
- Cache `notifications:{student_id}` in Redis with a 60-second TTL
- On page load, check Redis first. Cache miss → query DB, populate cache
- On new notification → invalidate that student's cache key
- **Tradeoff:** Up to 60s stale data. Works well for notifications that don't need instant refresh

**Strategy 2: Pagination + Cursor**
- Never fetch all notifications at once — use cursor-based pagination (`?cursor=<last_id>&limit=20`)
- Dramatically reduces DB rows returned per request
- **Tradeoff:** UI must support infinite scroll; slightly more complex frontend

**Strategy 3: Unread Count Cache Only**
- Only cache the unread count (cheap integer) in Redis
- Full notification list only fetched when inbox is opened (not every page load)
- **Tradeoff:** Requires UI change — badge shows count, not full list on load

**Recommended:** Combine Strategy 2 + 3. Cache only the unread count. Lazy-load the full list with pagination.

---

## Stage 5

### Notify-All Analysis

**Shortcomings of the original implementation:**
1. Sequential loop — 50,000 iterations is slow and blocks the thread
2. `send_email` failure for 200 students means those emails are silently dropped — no retry
3. `save_to_db` and `send_email` are tightly coupled — if email fails, the DB insert might still run (or not), leaving inconsistent state
4. No visibility into partial failures

**Redesigned approach — Message Queue:**
```
HR clicks "Notify All"
        ↓
API enqueues 50,000 jobs into a queue (e.g. BullMQ / RabbitMQ)
        ↓
Worker pool picks up jobs in parallel (e.g. 10 workers)
        ↓
Each worker: save_to_db() then send_email() with retry (3 attempts)
        ↓
Failed jobs go to a Dead Letter Queue for manual review / re-trigger
```

**Should DB save and email happen together?**
No — they should be separate concerns with separate failure handling. Save to DB first (source of truth), then send email. If email fails, retry from the queue. This way the notification is never lost.

**Revised pseudocode:**
```
function notify_all(student_ids, message):
  for student_id in student_ids:
    enqueue_job({student_id, message})  # fast, non-blocking

worker function process_job(job):
  save_to_db(job.student_id, job.message)  # guaranteed first
  retry(3, lambda: send_email(job.student_id, job.message))
  push_to_app(job.student_id, job.message)
  if all_retries_fail:
    send_to_dead_letter_queue(job)
```

---

## Stage 6

### Priority Inbox — Top N Notifications

**Approach:** Min-heap of size N.

A min-heap always keeps the N highest-priority items efficiently. For each new notification:
- If heap size < N → push directly
- Else if new item's priority > heap minimum → pop minimum, push new item
- This maintains top N in O(log N) per insertion — far better than sorting all notifications

**Priority scoring:**
```
weight = { Placement: 3, Result: 2, Event: 1 }
score = weight[type] * 1000 + unix_timestamp
```
This means Placement always beats Result which always beats Event. Within the same type, more recent wins.

See `notification_app_be/priority_inbox.js` for implementation.