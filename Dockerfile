# syntax=docker/dockerfile:1
#
# Multi-stage build for the ALeRCE Explorer (htmx + FastAPI).
#   1. css      — compile Tailwind -> src/static/css/main.css (Node, build-only)
#   2. deps     — resolve Python deps into a venv via Poetry (build-only)
#   3. runtime  — slim image with only the venv, the app, and the built CSS,
#                 running as a non-root user.
#
# No secrets are ever COPYed in. Runtime config (API_URL, future tokens) is
# injected via environment variables at `docker run` / compose time.

############################
# 1. Build Tailwind CSS
############################
FROM node:20-slim AS css
WORKDIR /app
COPY package.json tailwind.config.js ./
RUN npm install
# Tailwind scans templates / js / routes (see tailwind.config.js `content`)
COPY src ./src
RUN npm run build:css


############################
# 2. Python dependencies
############################
FROM python:3.12-slim AS deps
ENV PIP_NO_CACHE_DIR=1 \
    POETRY_VERSION=1.8.3 \
    POETRY_VIRTUALENVS_IN_PROJECT=true \
    POETRY_NO_INTERACTION=1
RUN pip install "poetry==${POETRY_VERSION}"
WORKDIR /app
COPY pyproject.toml poetry.lock ./
# Only the main (runtime) deps — no test group, no dev tooling.
RUN poetry install --only main


############################
# 3. Runtime image
############################
FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/app/.venv/bin:$PATH"

# Non-root user — the app never needs root, and this limits blast radius.
RUN useradd --create-home --uid 10001 appuser
WORKDIR /app

# Virtualenv from the deps stage
COPY --from=deps /app/.venv /app/.venv

# Application source + the compiled CSS from the css stage
COPY src ./src
COPY --from=css /app/src/static/css/main.css ./src/static/css/main.css

USER appuser
EXPOSE 8000

# Bind to 0.0.0.0 so the container is reachable from the Caddy container.
# Public TLS is terminated by Caddy, not here.
CMD ["uvicorn", "src.app:app", "--host", "0.0.0.0", "--port", "8000"]
