# Contributing to NGP Mobility

Thank you for contributing!

## Local Setup

```bash
npm install
cp .env.example .env
# Add TOMTOM_API_KEY to .env
npm start
```

## Quality Gates

Every pull request must pass all checks before merge:

```bash
npm run lint
npm run typecheck
npm run test:coverage
npm audit --audit-level=moderate
```

## Guidelines
- Keep changes focused and modular.
- Validate all external inputs with Zod `.strict()` schemas.
- Never hardcode secrets, credentials, or synthetic/mock data presented as real.
- Preserve accessibility (keyboard navigation, ARIA labels, contrast) and i18n parity (`en`, `hi`, `mr`).
