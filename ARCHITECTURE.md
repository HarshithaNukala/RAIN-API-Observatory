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

### Future Role: Telemetry
*(FUTURE PHASE)* Metrics will be collected and stored for later aggregation and dashboarding (response latency, status codes, etc.).

### Future Role: Incident Engine
*(FUTURE PHASE)* Automated incident detection will analyze telemetry data and trigger alerts/incidents when an API fails consecutively or drops below performance thresholds.

## PostgreSQL Layer (Database)
- **Why PostgreSQL**: Rock-solid, open-source relational database. Perfect for structured telemetry, configurations, and incidents.
- **Flyway**: Used for reliable, version-controlled database migrations.

**Important Rule**: One Source of Truth. The frontend dashboard must not contain hard-coded stats (like total APIs = 4). Everything must originate from the backend database.
