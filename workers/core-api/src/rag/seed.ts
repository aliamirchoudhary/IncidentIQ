import type { ChunkInput } from "./types";

const SEED_DOCUMENTS: ChunkInput[] = [
  // ===== 5 Runbooks =====
  {
    source_id: "seed-runbook-1",
    title: "Connection Pool Exhaustion Runbook",
    type: "runbook",
    tags: ["database", "connection-pool", "postgresql", "scaling"],
    content: `## Symptoms

Applications report "Cannot acquire JDBC connection" or "Connection pool exhausted" errors. Database query latency increases sharply. Monitoring dashboards show active connections at or near the configured pool maximum. New connection attempts queue up or fail immediately depending on the pool implementation.

## Immediate Mitigation

1. Identify the pool size limits by checking the application configuration or database server max_connections setting. Common defaults are 20-50 connections per application instance.
2. Temporarily increase the connection pool maximum size by 50% through the application's configuration management system. This provides immediate relief while the root cause is investigated.
3. If the database server itself is at its connection limit, kill long-running idle queries using pg_terminate_backend() for PostgreSQL or equivalent for other databases.
4. Consider restarting connection-pooling middleware like PgBouncer or HikariCP if connections are in a stuck state.

## Root Cause Investigation

Common causes include: sudden traffic spike exceeding normal pool sizing, connection leaks where application code fails to return connections to the pool, database-side slowness causing connections to be held longer than expected, and misconfigured pool size after a deployment that increased instance count without adjusting per-instance pool limits.

## Prevention

Set up pool utilization alerting at 80% of maximum. Implement circuit breakers on downstream service calls to prevent cascading connection exhaustion. Add connection timeout and leak detection parameters. Review pool sizing during every major deployment. Consider using a read-replica for read-only queries to reduce write-pool pressure.`,
  },
  {
    source_id: "seed-runbook-2",
    title: "Deployment Rollback Procedure",
    type: "runbook",
    tags: ["deployment", "rollback", "ci-cd", "release"],
    content: `## When to Roll Back

Roll back immediately if any of the following are observed within 30 minutes of deployment: error rate increases by more than 5%, p99 latency increases by more than 50%, any critical endpoint returns 5xx errors, or a known monitoring alert fires that was not present before the deployment.

## Rollback Steps

1. Notify the team via the designated communication channel. Include the deployment ID, time of deployment, and observed symptoms.
2. For Kubernetes deployments: kubectl rollout undo deployment/app-name. For serverless/Worker deployments: use the platform's built-in version rollback or re-deploy the previous stable tag.
3. Verify rollback success by monitoring the same metrics that triggered the decision. Confirm error rates return to pre-deployment baseline within 5 minutes.
4. If rollback fails, escalate to the platform engineering team and consider a canary deployment of the previous version to gradually shift traffic.

## Post-Rollback

Tag the failed deployment in the incident report. Schedule a postmortem within 24 hours. Do not re-deploy the same change until the root cause is identified and fixed. Apply any urgent hotfix as a separate change with its own review cycle.`,
  },
  {
    source_id: "seed-runbook-3",
    title: "Database Failover Runbook",
    type: "runbook",
    tags: ["database", "failover", "high-availability", "postgresql"],
    content: `## Failover Triggers

Automatic failover is triggered when the primary database node is unreachable for more than 30 seconds, replication lag exceeds 60 seconds, or the primary's disk is full. Manual failover may be initiated during planned maintenance.

## Failover Process

1. Verify that the standby replica is healthy and fully caught up by checking replication lag. If lag exceeds 30 seconds, consider waiting or triggering a forced failover depending on the severity.
2. Promote the standby to primary using the database management tool appropriate for your setup: pg_ctl promote for PostgreSQL streaming replication, or the cloud provider's failover API for managed databases.
3. Update application configuration or DNS to point to the new primary. For managed databases, this is typically automatic.
4. Verify that all connected services can reach the new primary and that queries are executing normally.

## Post-Failover

Once the original primary is restored, set it up as a replica of the new primary rather than failing back immediately. Schedule failback during the next maintenance window after confirming the restored node is stable. Document the failover cause and any configuration changes needed to prevent recurrence.`,
  },
  {
    source_id: "seed-runbook-4",
    title: "API Rate Limiting Incident Response",
    type: "runbook",
    tags: ["api", "rate-limiting", "availability", "throttling"],
    content: `## Identifying Rate Limiting Issues

Clients receive HTTP 429 Too Many Requests responses. Monitoring shows request queue depth increasing. P95 latency rises as requests are queued. The rate limiter's counter approaches or exceeds the configured threshold for the affected client or endpoint.

## Immediate Actions

1. Identify the affected client or endpoint from the rate limiter logs. Common patterns include a single client ID with excessive requests or a specific API endpoint receiving unexpected traffic.
2. If the client is legitimate (e.g., a paying customer), temporarily increase their rate limit quota through the admin interface. Set a time-bound override that expires automatically.
3. If the traffic is from an unknown or abusive source, block the client ID or IP range at the edge using WAF rules or the API gateway.
4. For internal services affected by rate limiting, check if a deployment changed the expected call pattern and adjust the limit accordingly.

## Long-term Fixes

Implement adaptive rate limiting that considers historical traffic patterns rather than fixed thresholds. Add burst capacity for legitimate traffic spikes. Monitor rate limit hit rates and adjust defaults quarterly. Document rate limits clearly in API documentation so clients can design around them.`,
  },
  {
    source_id: "seed-runbook-5",
    title: "Memory Leak Detection and Mitigation",
    type: "runbook",
    tags: ["memory", "performance", "garbage-collection", "nodejs"],
    content: `## Detecting a Memory Leak

Key indicators: heap usage grows monotonically over time and does not decrease after garbage collection cycles. Container or process RSS memory increases steadily. The application restarts due to OutOfMemory errors or health check failures. Grafana or Datadog heap panels show a sawtooth pattern with an upward baseline trend.

## Immediate Mitigation

1. Restart the affected service instances gradually to reclaim memory. Use a rolling restart to avoid full service disruption.
2. Capture a heap dump before restarting if possible: jmap for Java, heapdump for Node.js, or the equivalent for your runtime.
3. Increase the memory limit for the service as a temporary measure while investigating.
4. If the leak is severe and affects all instances, scale up to more instances with lower memory each to distribute the load.

## Root Cause Investigation

Analyze the heap dump to identify objects accumulating over time. Common causes include: event listeners not being properly unregistered, closures holding references to large objects, cache implementations without eviction policies, and circular references in data structures. Use memory profiling tools to compare heap snapshots taken at different times.`,
  },

  // ===== 2 Past Incidents =====
  {
    source_id: "seed-past-incident-1",
    title: "Production Outage — March 2026",
    type: "past_incident",
    tags: ["outage", "database", "connection-pool", "postmortem"],
    content: `## Summary

On March 15, 2026, the production environment experienced a 45-minute service outage affecting all customer-facing API endpoints. The root cause was database connection pool exhaustion triggered by an unannounced traffic spike from a marketing campaign combined with a connection leak introduced in the previous day's deployment.

## Timeline

The incident began at 14:02 UTC when monitoring detected a sharp increase in database connection errors. At 14:05, the on-call engineer was paged. At 14:08, the connection pool reached 100% utilization and the API began returning 503 errors. At 14:15, the engineering team identified the connection pool exhaustion. The pool maximum was increased from 30 to 60 at 14:18, restoring partial service. At 14:25, a code-level connection leak was found and patched in a hotfix deployment. Full service was restored by 14:47.

## Root Cause

The previous day's deployment introduced a code path where database connections were not returned to the pool after a specific error scenario. This code path was exercised approximately 200 times during the traffic spike, exhausting 30 connections that were never released. Combined with legitimate traffic requiring 20-25 connections, the pool was exhausted within 6 minutes of the spike.

## Recommendations

1. Add connection leak detection with automatic alerting (HikariCP leakDetectionThreshold).
2. Implement circuit breaker pattern on the database client to fail fast when connections are unavailable.
3. Increase pool size alert threshold from 80% to 70% to allow more response time.
4. Add pre-deployment connection-pool stress testing to the CI pipeline.`,
  },
  {
    source_id: "seed-past-incident-2",
    title: "Degraded Performance — April 2026",
    type: "past_incident",
    tags: ["performance", "deployment", "rollback", "cd", "postmortem"],
    content: `## Summary

On April 8, 2026, the reporting API endpoint experienced degraded performance for approximately 90 minutes. P95 latency increased from 200ms to 2.3 seconds. The root cause was a deployment that introduced an N+1 query pattern in a frequently-used reporting endpoint.

## Timeline

At 09:30 UTC, a new deployment was pushed containing optimizations to the reporting module. At 09:38, monitoring detected p95 latency exceeding 1 second on the reports endpoint. At 09:45, the deployment was identified as the likely cause. Rollback was initiated at 09:47 and completed at 09:52. Latency returned to normal by 10:00. The full incident duration was driven by investigation time, not recovery time.

## Root Cause

The deployment changed a JOIN-based query to use ORM lazy loading, which resulted in N+1 query execution. For a report with 50 rows, this meant 1 + 50 queries instead of 1. The endpoint was called approximately 30 times per minute during peak hours, generating 1,530 queries per minute instead of 30.

## Recommendations

1. Add query count monitoring to the observability stack.
2. Add a database query audit step to the CI pipeline that flags N+1 patterns.
3. Lower the rollback threshold from 30 minutes to 10 minutes for latency regressions.
4. Include a load test step in the deployment pipeline that runs against a staging environment before production.`,
  },
];

export function getSeedDocuments(): ChunkInput[] {
  return SEED_DOCUMENTS;
}
