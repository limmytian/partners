# Contributing to Partners

Thank you for your interest in contributing to Partners! We welcome contributions from the community.

## Code of Conduct

Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md) in all community interactions.

## Development Workflow

### Prerequisites

- Node.js >= 20
- Docker & Docker Compose (optional, for local smoke tests)
- Kubernetes cluster (optional, for Kubernetes provider validation)

### Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/limmytian/partners.git
   cd partners
   ```

2. Install dependencies:
   ```bash
   npm ci
   ```

3. Run the test suite:
   ```bash
   npm test
   ```

### Running Local Integration Smoke Tests

To run the local gateway smoke tests with PostgreSQL and MinIO (S3 compatible):

```bash
docker compose -f docker-compose.gateway-smoke.yml up -d --build
SMOKE_CHECK_DEPENDENCIES=1 \
SMOKE_EXPECT_ARTIFACT_BACKEND=s3 \
SMOKE_RESTART_COMMAND="docker compose -f docker-compose.gateway-smoke.yml restart gateway" \
  npm run gateway:smoke
docker compose -f docker-compose.gateway-smoke.yml down -v
```

## Pull Request Guidelines

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feature/my-feature
   ```
2. Make sure all unit tests pass:
   ```bash
   npm test
   ```
3. Commit your changes with descriptive commit messages following Conventional Commits.
4. Push to your fork and submit a Pull Request to `main`.
5. Ensure CI checks pass.

## License

By contributing to Partners, you agree that your contributions will be licensed under its [Apache-2.0 License](LICENSE).
