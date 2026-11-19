<p align="center">
  <img src="frontend/public/favicon.svg" alt="RAIN Logo" width="80" />
</p>

<h1 align="center">RAIN — API Reliability Observatory</h1>

<p align="center">
  <strong>Know your APIs before your users do.</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#tech-stack">Tech Stack</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#api-reference">API Reference</a> •
  <a href="#contributing">Contributing</a> •
  <a href="#license">License</a>
</p>

---

RAIN is a **third-party API reliability monitoring platform** that lets development teams register external APIs, run automated health checks, measure uptime, track latency trends, detect incidents, and surface anomalies — all from a single observatory dashboard.

## Features

| Capability | Description |
|---|---|
| **API Registry** | Register, edit, pause, and manage external API endpoints with custom headers and HTTP methods |
| **Monitoring Engine** | Scheduled health checks with configurable intervals and SSRF-hardened request execution |
| **Telemetry & Metrics** | Uptime percentage, average/P95 latency, success/failure ratios with time-window bucketing |
| **Incident Engine** | Automatic incident detection from consecutive failures with pessimistic-lock concurrency safety |
| **Intelligence Engine** | Anomaly detection, error-type classification, and reliability scoring |
| **Observatory Dashboard** | Real-time overview with latency charts, success/failure trends, incident feed, and intelligence panels |

## Tech Stack

| Layer | Technologies |
|---|---|
| **Frontend** | React 19, TypeScript, Vite, React Router 7, TanStack Query, Recharts, Tailwind CSS, Lucide Icons |
| **Backend** | Java 21, Spring Boot 3.x, Spring MVC, Spring Data JPA, Spring WebClient, Spring Scheduling |
| **Database** | PostgreSQL 15, Flyway Migrations |
| **Infrastructure** | Docker, Docker Compose |

## Quick Start

### Prerequisites

- **Java** 21+
- **Node.js** 22+ & npm 10+
- **Docker** & Docker Compose
- **Git**

### 1. Clone the repository

```bash
git clone https://github.com/HarshithaNukala/RAIN-API-Observatory.git
cd RAIN-API-Observatory
```

### 2. Configure environment

```bash
cp .env.example .env
# The defaults are ready for local development — adjust if needed
```

### 3. Start the database

```bash
docker compose up -d
```

PostgreSQL will be available on port `5432`. The healthcheck ensures it's ready before you proceed.

### 4. Start the backend

```bash
cd backend
./mvnw spring-boot:run      # Linux / macOS
mvnw.cmd spring-boot:run    # Windows
```

The API server starts on **http://localhost:8080**. Flyway runs all migrations automatically.

### 5. Start the frontend

```bash
cd frontend
npm install
npm run dev
```

The dashboard opens on **http://localhost:5173**.

### 6. Verify

```bash
curl http://localhost:8080/api/health
# → {"status":"UP","timestamp":"..."}
```

## Architecture

RAIN follows a **Modular Monolith** architecture — strict domain separation (Registry, Monitoring, Telemetry, Incidents, Intelligence) within a single deployable unit backed by one PostgreSQL database.

```
┌─────────────────────────────────────────────────────┐
│                   React Frontend                     │
│  Dashboard · Registry · API Details · Add API        │
└──────────────────────┬──────────────────────────────┘
                       │  REST / JSON
┌──────────────────────▼──────────────────────────────┐
│                 Spring Boot Backend                  │
│  ┌──────────┐ ┌───────────┐ ┌───────────────────┐   │
│  │ Registry │ │ Monitoring│ │ Telemetry/Metrics │   │
│  └──────────┘ └───────────┘ └───────────────────┘   │
│  ┌──────────┐ ┌──────────────────────────────────┐   │
│  │ Incidents│ │      Intelligence Engine         │   │
│  └──────────┘ └──────────────────────────────────┘   │
└──────────────────────┬──────────────────────────────┘
                       │  JDBC / JPA
┌──────────────────────▼──────────────────────────────┐
│          PostgreSQL 15 (Flyway-managed)              │
│  api_services · health_checks · incidents            │
└─────────────────────────────────────────────────────┘
```

> See [ARCHITECTURE.md](ARCHITECTURE.md) for in-depth design decisions, concurrency strategies, and telemetry formulas.

## Project Structure

```
RAIN-API-Observatory/
├── backend/
│   └── src/main/java/com/rain/
│       ├── config/            # WebClient, CORS configuration
│       ├── controller/        # REST controllers
│       ├── dto/               # Request/response DTOs
│       ├── entity/            # JPA entities & enums
│       ├── exception/         # Global error handling
│       ├── intelligence/      # Anomaly detection & scoring
│       ├── monitoring/        # Health checks, scheduler, SSRF guard
│       ├── repository/        # Spring Data repositories
│       └── service/           # Business logic
├── frontend/src/
│   ├── components/            # Reusable UI components
│   ├── pages/                 # Route-level page components
│   ├── services/              # API client & React Query hooks
│   └── types/                 # TypeScript type definitions
├── docs/                      # Additional documentation
├── infra/                     # Infrastructure configs
├── scripts/                   # Utility scripts
├── docker-compose.yml         # PostgreSQL service
├── ARCHITECTURE.md            # Design & architecture docs
└── .env.example               # Environment variable template
```

## API Reference

### Health

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Application health check |

### API Registry

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/services` | List all registered APIs |
| `GET` | `/api/services/{id}` | Get API details |
| `POST` | `/api/services` | Register a new API |
| `PUT` | `/api/services/{id}` | Update an API |
| `PATCH` | `/api/services/{id}/pause` | Pause monitoring |
| `PATCH` | `/api/services/{id}/resume` | Resume monitoring |
| `DELETE` | `/api/services/{id}` | Remove an API |

### Metrics & Telemetry

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/metrics/dashboard` | Dashboard summary stats |
| `GET` | `/api/metrics/services/{id}` | Per-API uptime, latency, P95 |
| `GET` | `/api/metrics/services/{id}/latency-series` | Latency time series |
| `GET` | `/api/metrics/services/{id}/success-failure-series` | Success/failure time series |

### Incidents

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/incidents` | List all incidents |
| `GET` | `/api/incidents/api/{apiId}` | Incidents for a specific API |

### Intelligence

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/intelligence/services/{id}` | Anomaly detection & reliability analysis |

## Database Migrations

Flyway migrations are located in `backend/src/main/resources/db/migration/`:

| Version | Description |
|---|---|
| `V1` | Initial schema setup |
| `V2` | API registry tables |
| `V3` | Monitoring engine schema |
| `V4` | Telemetry & metrics indexes |
| `V5` | Incident engine schema |

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
