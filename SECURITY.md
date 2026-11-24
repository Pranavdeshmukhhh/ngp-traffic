# Security Policy

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities, exposed credentials, or bypasses.

Report issues privately via GitHub Security Advisories (`Security -> Advisories -> Report a vulnerability`) or contact the repository maintainers directly. Include:
- Affected endpoint, file, or configuration
- Minimal reproduction steps or proof of concept
- Impact assessment

## Security Principles
- API keys (`TOMTOM_API_KEY`) must stay server-side only; never commit `.env` or secret files.
- All query, tile, and coordinate inputs are validated strictly with Zod.
- Production deployments must set an explicit `ALLOWED_ORIGIN` allow-list.
