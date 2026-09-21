# RAIN — API Reliability Observatory

**"Know your APIs before your users do."**

RAIN is a third-party API reliability monitoring platform. It allows developers to register external APIs, configure monitoring schedules, perform automated health checks, measure uptime, and track incidents.

## Current Phase: Phase 1 (Foundations)
This project is being developed phase-by-phase. We are currently in Phase 1, which establishes the architectural foundations of the system without implementing core monitoring features.

## Problem Statement
Third-party APIs frequently fail, change, or degrade in performance. Developers often discover these issues only when their users report them. RAIN provides an observatory to monitor external API reliability proactively.

## Technology Stack
- **Frontend**: React, TypeScript, Vite, React Router, TanStack Query, Recharts, Tailwind CSS
- **Backend**: Java 21, Spring Boot 3.x, Spring MVC, Spring Data JPA, Spring WebClient (for future monitoring calls)
- **Database**: PostgreSQL, Flyway
- **Infrastructure**: Docker, Docker Compose

## Prerequisites
- Java 21 & Javac 21
- Node.js 22.x & npm 10.x
- Docker & Docker Compose
- Git

## Project Structure
- `/frontend`: React application
- `/backend`: Spring Boot application
- `/docs`: Documentation
- `/infra`: Infrastructure configuration
- `/scripts`: Utility scripts

## Environment Setup
1. Copy `.env.example` to `.env` in the root folder.
2. Fill in the values (the defaults in `.env.example` are suitable for local development).

## PostgreSQL Setup
Run the following command from the project root:
```bash
docker compose up -d
```
This will start a PostgreSQL instance on port 5432.

## Backend Startup
Navigate to the `backend` directory:
```bash
cd backend
./mvnw spring-boot:run
```
The backend will start on port 8080. Flyway will automatically run database migrations.

## Frontend Startup
Navigate to the `frontend` directory:
```bash
cd frontend
npm install
npm run dev
```
The frontend will start on port 5173.

## Health Endpoint
Test the backend is running by accessing:
```
GET http://localhost:8080/api/health
```

## Future Phases
- API registration and management
- Monitoring scheduler and health checks
- Telemetry and uptime calculations
- Incident detection and resolution
- Real-time updates and notifications
- Analytics and dashboarding
- Authentication and authorization
