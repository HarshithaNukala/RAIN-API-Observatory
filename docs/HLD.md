# High-Level Design (HLD)
## RAIN — Third-Party API Reliability Observatory

**Document Reference:** RAIN-DOC-HLD-001  
**Project:** RAIN API Observatory  
**Target Audience:** Kalvium University Project Assessor, Evaluation Panel, System Architects  
**Architecture Style:** Modular Monolith  
**Version:** 1.0.0  

---

## 1. System Architecture

### 1.1 Architectural Style: Modular Monolith
RAIN is architected as a **Modular Monolith**. Rather than adopting a microservices architecture—which introduces operational complexity, distributed transaction overhead, network latency between internal services, and eventual consistency challenges—RAIN encapsulates distinct business domains into strict, decoupled modules residing within a single deployable application artifact.

```
┌───────────────────────────────────────────────────────────────────────────┐
│                           REACT PRESENTATION LAYER                        │
│   (Vite, React 19, TypeScript, TanStack Query, Recharts, Tailwind CSS)    │
└─────────────────────────────────────┬─────────────────────────────────────┘
                                      │ HTTP / REST (JSON)
                                      ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                       SPRING BOOT APPLICATION LAYER                       │
│  ┌───────────────────────┐ ┌───────────────────────┐ ┌─────────────────┐  │
│  │  API Registry Domain  │ │   Monitoring Domain   │ │ Telemetry Domain│  │
│  └───────────────────────┘ └───────────────────────┘ └─────────────────┘  │
│  ┌───────────────────────┐ ┌───────────────────────┐ ┌─────────────────┐  │
│  │    Incident Domain    │ │  Intelligence Domain  │ │ Security (SSRF) │  │
│  └───────────────────────┘ └───────────────────────┘ └─────────────────┘  │
└─────────────────────────────────────┬─────────────────────────────────────┘
                                      │ JDBC / JPA / HikariCP
                                      ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                         POSTGRESQL STORAGE LAYER                          │
│               (PostgreSQL 15 Alpine, Flyway Database Migrations)          │
└───────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Rationale for Architectural Choices
1. **Strong Consistency & ACID Transactions:** Health evaluation and incident state transitions demand absolute transactional boundaries. A single relational database enables PostgreSQL pessimistic write locks (`PESSIMISTIC_WRITE`) and partial unique indexes to eliminate duplicate open incidents without distributed locking engines (such as Redis/Redlock or ZooKeeper).
2. **Simplified Operational Footprint:** A single containerized database paired with a Spring Boot JAR delivers maximum developer productivity, straightforward local setup, and rapid continuous integration testing.
3. **High-Throughput I/O with Virtual Threads:** The execution of outbound network calls does not block operating system platform threads. Java 21 Virtual Threads (`Executors.newVirtualThreadPerTaskExecutor()`) permit hundreds of concurrent outbound health checks with minimal memory overhead.
4. **Decoupled Module Boundaries:** Each domain possesses its own entities, repositories, and services. Modules communicate via direct service interfaces without leaking internal transactional states.

---

## 2. Technology Stack

### 2.1 Technology Stack Summary Table

| Layer | Component | Version | Role & Justification |
|---|---|---|---|
| **Frontend** | React | 19.3.0 | Modern declarative UI library using functional components and hooks. |
| | TypeScript | 6.0.2 | Compile-time static type safety and DTO contract adherence. |
| | Vite | 8.3.0 | Next-generation bundler with instant Hot Module Replacement (HMR). |
| | TanStack Query | 5.103.2 | Asynchronous server state management, caching, and 30s background refetching. |
| | Recharts | 3.10.1 | Composable SVG-based chart library for latency and availability visualization. |
| | Tailwind CSS | 3.4.19 | Utility-first styling enabling a clean, modern SRE observatory aesthetic. |
| | Lucide React | 1.47.0 | Consistent icon library for observability indicators and statuses. |
| **Backend** | Java | 21 (LTS) | Modern Java runtime utilizing Project Loom Virtual Threads for scalable concurrency. |
| | Spring Boot | 3.4.0 | Core enterprise application framework providing dependency injection and auto-configuration. |
| | Spring MVC | 3.4.0 | Synchronous servlet stack for exposing clean, structured REST APIs. |
| | Spring Data JPA | 3.4.0 | Object-Relational Mapping (Hibernate 6) for domain entity persistence. |
| | Spring WebFlux / Reactor Netty | 3.4.0 | Reactive HTTP client (`WebClient`) used for non-blocking outbound health check requests. |
| | Flyway Core | 10.x | Version-controlled, idempotent database schema migrations. |
| **Database** | PostgreSQL | 15 (Alpine) | Robust relational database supporting advanced SQL analytics (`PERCENTILE_CONT`, `FILTER`). |
| **Infrastructure** | Docker Compose | 3.8 Spec | Orchestration for local containerized PostgreSQL instance with automated health checks. |

---

## 3. Major Components & Responsibilities

```mermaid
flowchart TB
    subgraph Frontend["Frontend Layer (React 19 + TypeScript)"]
        UI_Dash["Dashboard View"]
        UI_Reg["API Registry View"]
        UI_Det["API Details & Telemetry View"]
        UI_Intel["Intelligence & Anomaly Panel"]
        UI_Feed["Incident Feed"]
        RQ["TanStack React Query Cache"]
        
        UI_Dash --> RQ
        UI_Reg --> RQ
        UI_Det --> RQ
        UI_Intel --> RQ
        UI_Feed --> RQ
    end

    subgraph Backend["Backend Layer (Spring Boot 3.4 / Java 21)"]
        subgraph Controllers["REST Controllers"]
            C_Reg["ApiServiceController"]
            C_Met["MetricsController"]
            C_Inc["IncidentController"]
            C_Int["IntelligenceController"]
            C_Hlt["HealthController"]
        end

        subgraph Services["Core Domain Services"]
            S_Reg["ApiRegistryService"]
            S_Mon["MonitoringEngineService"]
            S_Met["MetricsService"]
            S_Inc["IncidentService"]
            S_Int["IntelligenceService"]
        end

        subgraph MonitoringCore["Monitoring & Execution Subsystem"]
            SCHED["MonitoringScheduler (1000ms tick)"]
            EXEC["HealthCheckExecutor"]
            SSRF_VAL["SsrfValidator"]
            SSRF_RES["SsrfAddressResolverGroup (Netty)"]
            V_POOL["Virtual Thread Pool (Semaphore 100)"]
            WC["WebClient (Reactor Netty)"]
        end

        subgraph Repos["Data Access Layer (JPA / JDBC)"]
            R_Reg["ApiServiceRepository (JPA)"]
            R_Chk["HealthCheckRepository (JPA)"]
            R_Inc["IncidentRepository (JPA)"]
            R_Met["MetricsRepository (JdbcTemplate)"]
        end
    end

    subgraph Database["PostgreSQL 15 Database"]
        T_Serv[("api_services")]
        T_Head[("api_headers")]
        T_Chk[("health_checks")]
        T_Inc[("incidents")]
        T_Meta[("app_metadata")]
    end

    subgraph External["External World"]
        TargetAPI["Monitored 3rd-Party APIs"]
    end

    RQ -->|HTTP / JSON| Controllers
    C_Reg --> S_Reg
    C_Met --> S_Met
    C_Inc --> S_Inc
    C_Int --> S_Int
    C_Hlt --> R_Reg

    S_Reg --> R_Reg
    S_Reg --> R_Inc
    S_Met --> R_Met
    S_Met --> R_Reg
    S_Met --> R_Inc
    S_Inc --> R_Inc
    S_Int --> R_Chk
    S_Int --> R_Inc
    S_Int --> R_Reg

    SCHED -->|Query Due APIs| R_Reg
    SCHED -->|Dispatch Tasks| V_POOL
    V_POOL --> S_Mon
    S_Mon --> EXEC
    EXEC --> SSRF_VAL
    EXEC --> WC
    WC --> SSRF_RES
    SSRF_RES -->|Validate IP before connect| TargetAPI
    WC -->|Non-blocking HTTP call| TargetAPI
    
    S_Mon -->|Pessimistic Lock & Save| R_Reg
    S_Mon -->|Save Check Record| R_Chk
    S_Mon -->|Open / Resolve Incidents| R_Inc

    R_Reg --> T_Serv
    R_Reg --> T_Head
    R_Chk --> T_Chk
    R_Inc --> T_Inc
    R_Met --> T_Chk
    R_Met --> T_Serv
```

### 3.1 Component Breakdown

#### 1. API Registry Component
- **Package:** `com.rain.controller.ApiServiceController`, `com.rain.service.ApiRegistryService`
- **Responsibilities:**
  - Manages API registration, configuration updates, deletion, pausing, and resuming.
  - Enforces URL validation (valid URI scheme, hostname validation).
  - Sanitizes sensitive request headers before returning metadata to clients.
  - Cross-references active incidents to return `hasActiveIncident` flags.

#### 2. Monitoring Scheduler & Concurrency Dispatcher
- **Package:** `com.rain.monitoring.MonitoringScheduler`
- **Responsibilities:**
  - Runs periodically at a fixed delay of 1,000ms (`@Scheduled`).
  - Evaluates database state to find APIs with `next_check_at <= NOW()`.
  - Enforces duplicate in-flight prevention using a concurrent set (`activeChecks`).
  - Throttles concurrent executions using a `Semaphore` (maximum 100 concurrent workers).
  - Submits executions to Java 21 Virtual Threads (`Executors.newVirtualThreadPerTaskExecutor()`).

#### 3. Health Check Executor & SSRF Protection
- **Package:** `com.rain.monitoring.HealthCheckExecutor`, `SsrfValidator`, `SsrfAddressResolverGroup`
- **Responsibilities:**
  - Constructs outbound HTTP requests using reactive `WebClient` with custom headers and bodies.
  - Measures round-trip execution latency via high-resolution timers (`System.nanoTime()`).
  - Implements DNS-level validation via Netty's `AddressResolverGroup`, blocking private/loopback/cloud-metadata IP addresses before TCP handshake.
  - Enforces `followRedirect(false)` to prevent open-redirect SSRF bypasses.
  - Maps exceptions into categorized error types (`TIMEOUT`, `CONNECTION_REFUSED`, `DNS_ERROR`, `SSRF_BLOCKED`).

#### 4. Monitoring Engine & Incident Lifecycle Service
- **Package:** `com.rain.monitoring.MonitoringEngineService`, `com.rain.service.IncidentService`
- **Responsibilities:**
  - Evaluates check results against configured expected status codes and latency thresholds (`HEALTHY`, `DEGRADED`, `DOWN`).
  - Executes isolated transactional persistence via self-injected Spring AOP proxy (`@Transactional`).
  - Acquires pessimistic write lock (`@Lock(LockModeType.PESSIMISTIC_WRITE)`) on the target API row.
  - Manages incident lifecycle: creates a new `OPEN` incident on first failure, increments `failureCount` on sustained failure, and resolves the incident upon recovery.
  - Schedules the next execution timestamp: `nextCheckAt = checkedAt + checkIntervalSeconds`.

#### 5. Telemetry & Analytics Engine
- **Package:** `com.rain.monitoring.MetricsService`, `com.rain.repository.MetricsRepository`
- **Responsibilities:**
  - Executes high-performance SQL analytics via Spring `JdbcTemplate`.
  - Calculates check-based uptime percentage, failure rate, average latency, and P95 latency.
  - Performs time-series aggregation using PostgreSQL native `date_trunc` with UTC time bucketing.
  - Powers dashboard summaries across 1h, 6h, 24h, 7d, and 30d time horizons.

#### 6. Intelligence & Anomaly Engine
- **Package:** `com.rain.intelligence.IntelligenceService`, `com.rain.intelligence.IntelligenceController`
- **Responsibilities:**
  - Computes composite 0–100 reliability scores based on 70% availability and 30% latency compliance.
  - Evaluates performance trends (`IMPROVING`, `STABLE`, `DECLINING`) against historical baselines.
  - Runs statistical anomaly detection ($\mu + 3\sigma$) on latency data points.
  - Identifies predominant error types and computes Mean Time to Recovery (MTTR).
  - Synthesizes automated root cause diagnostic hints.

#### 7. Presentation Layer (React SPA)
- **Package:** `frontend/src/`
- **Responsibilities:**
  - Displays real-time operational dashboard with auto-polling every 30 seconds.
  - Renders Recharts-powered interactive latency and success/failure distribution graphs.
  - Facilitates API service onboarding with comprehensive input validation.
  - Renders incident audit logs and intelligence diagnostic cards.

---

## 4. Data Flow Diagrams (DFD)

### 4.1 DFD Level 0: Context Diagram

```mermaid
flowchart LR
    User([SRE / Developer]) <-->|HTTP / Web UI| RAIN[RAIN API Observatory]
    RAIN -->|Non-blocking Health Probe| ExtAPI[Third-Party External APIs]
    ExtAPI -->|HTTP Status & Latency| RAIN
```

### 4.2 DFD Level 1: System Workflow Diagram

```mermaid
flowchart TD
    subgraph Client["Browser Client"]
        Browser[User in Web Browser]
    end

    subgraph RegistryFlow["API Registration Flow"]
        Browser -->|1. POST /api/services| API_Ctrl[ApiServiceController]
        API_Ctrl -->|2. Validate & Map| Reg_Serv[ApiRegistryService]
        Reg_Serv -->|3. Persist API & Headers| DB_Serv[(api_services & api_headers)]
    end

    subgraph MonitoringFlow["Automated Monitoring Flow"]
        Sched[MonitoringScheduler] -->|4. Every 1000ms: findDueApiIds| DB_Serv
        Sched -->|5. Acquire Semaphore & Virtual Thread| Mon_Serv[MonitoringEngineService]
        Mon_Serv -->|6. Execute Outbound Call| Exec[HealthCheckExecutor]
        Exec -->|7. DNS Resolve & SSRF Validate| DNS[Netty SSRF Resolver]
        DNS -->|8. HTTP Probe| Target[External API Endpoint]
        Target -->|9. Response / Timeout| Exec
        Exec -->|10. HealthCheckResult| Mon_Serv
        Mon_Serv -->|11. Lock API Row PESSIMISTIC_WRITE| DB_Serv
        Mon_Serv -->|12. Insert Health Check Record| DB_Chk[(health_checks)]
        Mon_Serv -->|13. Create / Increment / Resolve| DB_Inc[(incidents)]
        Mon_Serv -->|14. Update last_checked & next_check_at| DB_Serv
    end

    subgraph TelemetryFlow["Telemetry & Analytics Flow"]
        Browser -->|15. GET /metrics & /intelligence| Met_Ctrl[Metrics & Intelligence Controllers]
        Met_Ctrl -->|16. Execute SQL Aggregations| DB_Chk
        Met_Ctrl -->|17. Query Incidents| DB_Inc
        Met_Ctrl -->|18. Return Dashboard JSON| Browser
    end
```

### 4.3 Outbound Health Check & Incident Evaluation Flow

```mermaid
sequenceDiagram
    autonumber
    participant Sched as MonitoringScheduler
    participant Mon as MonitoringEngineService
    participant Exec as HealthCheckExecutor
    participant Netty as SsrfAddressResolverGroup
    participant Target as External API
    participant DB as PostgreSQL Database

    Sched->>DB: SELECT id FROM api_services WHERE enabled=true AND next_check_at <= NOW()
    DB-->>Sched: List of Due API IDs [101, 102, ...]
    
    Sched->>Sched: Check activeChecks (Prevent concurrent duplicates)
    Sched->>Sched: Acquire Semaphore permit (max 100)
    
    Sched->>Mon: executeAndSaveCheck(apiId) [Virtual Thread]
    Mon->>DB: SELECT * FROM api_services WHERE id = apiId (Read Config)
    DB-->>Mon: ApiService Entity
    
    Mon->>Exec: execute(apiService)
    Exec->>Netty: Resolve hostname (DNS)
    Note over Netty: Check IP against Blacklist<br/>(Loopback, Private, Cloud Metadata)
    Netty-->>Exec: Valid Public IP Address
    
    Exec->>Target: HTTP Request (Method, Headers, Body, Timeout)
    Target-->>Exec: HTTP Response (Status Code, Latency)
    Exec-->>Mon: HealthCheckResult(success, httpStatus, latencyMs, error)
    
    Note over Mon: Start Database Transaction
    Mon->>DB: SELECT * FROM api_services WHERE id = apiId FOR UPDATE (Pessimistic Lock)
    Mon->>DB: INSERT INTO health_checks (...) VALUES (...)
    
    alt If Check Failed (!success)
        Mon->>DB: SELECT * FROM incidents WHERE api_id = apiId AND status = 'OPEN'
        alt No Open Incident
            Mon->>DB: INSERT INTO incidents (status='OPEN', started_at=now, failure_count=1, ...)
        else Existing Open Incident
            Mon->>DB: UPDATE incidents SET failure_count = failure_count + 1, latest_health_check_id = checkId
        end
    else If Check Succeeded (success)
        Mon->>DB: SELECT * FROM incidents WHERE api_id = apiId AND status = 'OPEN'
        alt Open Incident Exists
            Mon->>DB: UPDATE incidents SET status = 'RESOLVED', resolved_at = now
        end
    end
    
    Mon->>DB: UPDATE api_services SET current_status = status, next_check_at = now + interval
    Note over Mon: Commit Transaction & Release Pessimistic Lock
    
    Sched->>Sched: activeChecks.remove(apiId)
    Sched->>Sched: Semaphore.release()
```

---

## 5. Database Architecture & ER Diagram

### 5.1 Relational Schema Design
The relational database layer is managed through **Flyway version-controlled migrations** in `backend/src/main/resources/db/migration/`:
- `V1__init.sql`: Creates `app_metadata` table for platform version tracking.
- `V2__create_api_registry.sql`: Creates core `api_services` table and dependent `api_headers` table.
- `V3__monitoring_engine_schema.sql`: Adds execution columns (`request_body`, `last_checked_at`, `next_check_at`) to `api_services`, creates `health_checks` table and `idx_health_checks_api_id`.
- `V4__telemetry_metrics_index.sql`: Adds time-range query index `idx_health_checks_checked_at`.
- `V5__incident_engine_schema.sql`: Creates `incidents` table, indexes on `(api_service_id, status)` and `(started_at DESC)`, and the partial unique index `uq_incidents_one_open_per_api`.

### 5.2 Entity-Relationship (ER) Diagram

```mermaid
erDiagram
    APP_METADATA {
        int id PK
        varchar key UK
        text value
        timestamp created_at
    }

    API_SERVICES {
        bigserial id PK
        varchar name
        varchar url
        varchar method
        text description
        int expected_status_code
        int timeout_ms
        int latency_threshold_ms
        int check_interval_seconds
        boolean enabled
        varchar current_status
        timestamp created_at
        timestamp updated_at
        text request_body
        timestamp last_checked_at
        timestamp next_check_at
    }

    API_HEADERS {
        bigserial id PK
        bigint api_service_id FK
        varchar header_name
        varchar header_value
    }

    HEALTH_CHECKS {
        bigserial id PK
        bigint api_service_id FK
        timestamp checked_at
        boolean success
        varchar status
        int http_status
        int latency_ms
        varchar error_type
        text error_message
    }

    INCIDENTS {
        bigserial id PK
        bigint api_service_id FK
        varchar status
        timestamp started_at
        timestamp resolved_at
        bigint first_health_check_id FK
        bigint latest_health_check_id FK
        int failure_count
    }

    API_SERVICES ||--o{ API_HEADERS : "has many (ON DELETE CASCADE)"
    API_SERVICES ||--o{ HEALTH_CHECKS : "generates (ON DELETE CASCADE)"
    API_SERVICES ||--o{ INCIDENTS : "experiences (ON DELETE CASCADE)"
    HEALTH_CHECKS ||--o{ INCIDENTS : "triggers as first check (ON DELETE RESTRICT)"
    HEALTH_CHECKS ||--o{ INCIDENTS : "updates as latest check (ON DELETE RESTRICT)"
```

### 5.3 Critical Constraints & Indexes

1. **Partial Unique Index on Incidents:**
   ```sql
   CREATE UNIQUE INDEX uq_incidents_one_open_per_api
   ON incidents(api_service_id)
   WHERE status = 'OPEN';
   ```
   *Guarantees at the database engine level that no race condition can ever produce duplicate active incidents for an API.*

2. **Compound Index on Health Checks:**
   ```sql
   CREATE INDEX idx_health_checks_api_id ON health_checks(api_service_id, checked_at DESC);
   ```
   *Optimizes retrieval of historical checks, latest checks, and baseline calculations.*

3. **Global Timestamp Index:**
   ```sql
   CREATE INDEX idx_health_checks_checked_at ON health_checks(checked_at);
   ```
   *Enables high-speed time-bucketed aggregation for global dashboard telemetry.*

---

## 6. Deployment Architecture

### 6.1 Container & Host Topology

```
┌───────────────────────────────────────────────────────────────────────────┐
│                               HOST MACHINE                                │
│                                                                           │
│   ┌──────────────────────────┐             ┌──────────────────────────┐   │
│   │   Frontend Dev Server    │             │   Spring Boot Backend    │   │
│   │   (Vite / Node.js)       │             │   (Java 21 JVM)          │   │
│   │   Port: 5173             │             │   Port: 8080             │   │
│   └─────────────┬────────────┘             └─────────────┬────────────┘   │
│                 │ Vite Proxy (/api)                      │                │
│                 └────────────────────────────────────────┘                │
│                                                          │ JDBC (5432)    │
│                                                          ▼                │
│   ┌───────────────────────────────────────────────────────────────────┐   │
│   │   Docker Engine (docker-compose)                                  │   │
│   │   ┌───────────────────────────────────────────────────────────┐   │   │
│   │   │   Container: rain_postgres                                │   │   │
│   │   │   Image: postgres:15-alpine                               │   │   │
│   │   │   Internal Port: 5432  <===>  Host Port: 5432             │   │   │
│   │   │   Volume: postgres_data -> /var/lib/postgresql/data       │   │   │
│   │   │   Healthcheck: pg_isready -U rain_user -d rain_db         │   │   │
│   │   └───────────────────────────────────────────────────────────┘   │   │
│   └───────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Configuration & Environment Variables

| Variable Name | Default Value | Description |
|---|---|---|
| `POSTGRES_DB` | `rain_db` | PostgreSQL database name inside Docker. |
| `POSTGRES_USER` | `rain_user` | Database master username. |
| `POSTGRES_PASSWORD` | `rain_password` | Database master password. |
| `DATABASE_URL` | `jdbc:postgresql://localhost:5432/rain_db` | Spring Boot JDBC connection string. |
| `DATABASE_USERNAME` | `rain_user` | Spring datasource connection user. |
| `DATABASE_PASSWORD` | `rain_password` | Spring datasource connection password. |
| `FRONTEND_URL` | `http://localhost:5173` | Allowed origin for frontend clients. |
| `rain.monitoring.dispatcher-interval` | `1000` | Scheduler polling interval in milliseconds. |
| `rain.monitoring.max-concurrency` | `100` | Maximum simultaneous outbound health checks. |
