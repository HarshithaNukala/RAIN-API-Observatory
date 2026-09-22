# RAIN Architecture

## Core Architectural Style: Modular Monolith
RAIN is designed as a **Modular Monolith**. We explicitly chose not to use microservices. A modular monolith allows for simpler deployment, easier debugging, and transactional boundaries within a single PostgreSQL database, while maintaining strict logical separation between domains (Registry, Scheduler, Monitoring, Incidents) within the same codebase.

## React Layer (Frontend)
The frontend uses React with TypeScript and Vite.
- **Why React**: Huge ecosystem, component-based structure.
- **Why Vite**: Fast builds, instant hot module replacement.
- **TanStack Query**: For efficient data fetching, caching, and state management.
- **Tailwind CSS**: Rapid UI styling without bloated CSS files.

## Spring Boot Layer (Backend)
The backend is built with Java 21 and Spring Boot 3.x.
- **Why Java 21**: Virtual threads, modern language features, LTS stability.
- **Why Spring Boot**: Industry standard for robust web applications.
- **Why Spring MVC**: Traditional synchronous servlet stack (spring-boot-starter-web) provides a solid foundation for building the REST API, connecting to the database via JPA, and handling application logic.

### Future Role: WebClient
*(FUTURE PHASE)* While the core application runs on Spring MVC, we include `spring-boot-starter-webflux` to utilize `WebClient` for outbound third-party API monitoring calls. This provides a modern, non-blocking HTTP client suitable for parallel external requests without converting the entire internal server architecture to WebFlux.

### Future Role: Scheduler
*(FUTURE PHASE)* Spring Scheduling will handle background health checks to ensure APIs are monitored continuously based on user-defined intervals.

### Telemetry Engine (Phase 4)
Telemetry converts raw health checks into reliable platform metrics:
- **Check-Based Uptime**: Defined as `(successful checks / total checks) * 100`. This is based on observed checks, not strict elapsed-time.
- **Platform-wide Metric**: A pooled check-success percentage calculated globally across all `health_checks`.
- **Response Latency**: Time elapsed until an HTTP response is received (`latency_ms IS NOT NULL`). Nulls (timeouts) are explicitly excluded from average and P95 math.
- **P95 Latency**: Calculated using PostgreSQL `PERCENTILE_CONT(0.95)`.
- **Time Bucketing**: Aggregations use native PostgreSQL `date_trunc` at `UTC`.
- **Paused APIs**: Paused APIs do not generate new health checks, so they do not contribute to ongoing telemetry, but their historical checks remain part of metric calculations.
- **Future Retention Strategy**: Future phases will implement data rollups (partitioning or materialized views) to manage the growing `health_checks` table.

### Incident Engine (Phase 5)
Automated incident detection analyzes health check telemetry and manages the incident lifecycle:
- **One Incident Per Outage**: One continuous failure period produces exactly ONE incident (Open -> Resolved).
- **Concurrency & Transaction Safety**: The system enforces the rule "at most ONE OPEN incident per API" via:
  1. **Application-level Serialization**: JPA `@Lock(LockModeType.PESSIMISTIC_WRITE)` strictly serializes state transitions during health check processing.
  2. **Database Guarantee**: A PostgreSQL partial unique index (`uq_incidents_one_open_per_api WHERE status = 'OPEN'`) guarantees safety.
- **Incident Lifecycle**:
  - `DOWN` status creates a new `OPEN` incident or increments the failure count of an existing one.
  - `HEALTHY` or `DEGRADED` status resolves an `OPEN` incident. `DEGRADED` does not *create* an incident (reserving incidents for actual outages).
- **Timestamps**: Incident `startedAt` and `resolvedAt` are set to the actual observation time of the underlying health check, ensuring accurate MTTR.
- **Paused APIs**: If an incident is `OPEN` when an API is paused, it remains `OPEN`. Pausing does not magically resolve outages.
- **Normalization**: Error strings and HTTP statuses are not duplicated in the `incidents` table. They are projected from the associated `latest_health_check_id` via `IncidentDto`.

## PostgreSQL Layer (Database)
- **Why PostgreSQL**: Rock-solid, open-source relational database. Perfect for structured telemetry, configurations, and incidents.
- **Flyway**: Used for reliable, version-controlled database migrations.

**Important Rule**: One Source of Truth. The frontend dashboard must not contain hard-coded stats (like total APIs = 4). Everything must originate from the backend database.
