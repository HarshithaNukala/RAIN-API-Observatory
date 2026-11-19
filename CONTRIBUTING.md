# Contributing to RAIN

Thank you for your interest in contributing to RAIN — API Reliability Observatory! This document provides guidelines to help you get started.

## Getting Started

1. **Fork** the repository
2. **Clone** your fork locally
3. **Create a branch** for your feature or fix:
   ```bash
   git checkout -b feat/your-feature-name
   ```
4. **Follow the setup instructions** in [README.md](README.md#quick-start)

## Development Workflow

### Branch Naming

| Prefix | Usage |
|---|---|
| `feat/` | New features |
| `fix/` | Bug fixes |
| `docs/` | Documentation changes |
| `refactor/` | Code refactoring |
| `test/` | Adding or updating tests |
| `chore/` | Maintenance tasks |

### Commit Messages

Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
feat: add anomaly detection endpoint
fix: resolve race condition in incident creation
docs: update API reference for metrics
```

### Code Style

- **Java**: Follow standard Spring Boot conventions. Use meaningful names, keep methods focused, and document public APIs with Javadoc.
- **TypeScript/React**: Use functional components, React hooks, and TanStack Query for data fetching. Follow existing patterns in the codebase.
- **SQL Migrations**: Flyway naming convention — `V{n}__{description}.sql`. Never modify existing migrations; always create a new one.

## Pull Request Process

1. Ensure your code compiles and existing tests pass:
   ```bash
   cd backend && ./mvnw verify
   cd frontend && npm run typecheck && npm run lint
   ```
2. Update documentation if your changes affect the API or architecture.
3. Open a pull request against `main` with a clear description of what changed and why.
4. Link any relevant issues in the PR description.

## Reporting Issues

When filing an issue, please include:

- A clear, descriptive title
- Steps to reproduce the problem
- Expected vs. actual behavior
- Environment details (OS, Java version, Node version)

## Code of Conduct

Be respectful and constructive. We are all here to build great software together.
