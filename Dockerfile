# ---- Stage 0: Bridge dependencies (Node, for the TradingView bridge) ----
FROM node:22-bookworm-slim AS bridge

WORKDIR /bridge

# Only the lockfile and .npmrc (ignore-scripts) go in first, so this layer is cached
COPY bridge/package.json bridge/package-lock.json bridge/.npmrc ./
RUN npm ci --ignore-scripts --omit=dev
COPY bridge/ ./

# ---- Stage 1: Build ----
FROM python:3.11-slim AS builder

# Install system deps and uv
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="/usr/local/bin" sh

WORKDIR /app

# Copy everything (needed for editable install)
COPY . .

# Install the package and its dependencies into the system Python
RUN uv pip install --system .

# ---- Stage 2: Runtime ----
FROM python:3.11-slim

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=builder /usr/local/bin/tradingview-mcp /usr/local/bin/tradingview-mcp

# Copy app source (needed for coinlist data files etc.)
COPY --from=builder /app /app

# Node runtime and the TradingView bridge. No credentials are baked in:
# pass TRADINGVIEW_SESSION_ID / TRADINGVIEW_SESSION_SIGN at run time (see docs/tradingview-session.md)
COPY --from=bridge /usr/local/bin/node /usr/local/bin/node
COPY --from=bridge /bridge /app/bridge
ENV TRADINGVIEW_BRIDGE_PATH=/app/bridge/server.mjs
# Fails the build if the copied node binary cannot load in this base image
RUN node --version

# Create non-root user for security
RUN useradd -m mcpuser && chown -R mcpuser:mcpuser /app
USER mcpuser

# Expose the HTTP port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

# Run the MCP server over streamable-http (ideal for Docker/remote deployments)
ENTRYPOINT ["tradingview-mcp"]
CMD ["streamable-http", "--host", "0.0.0.0", "--port", "8000"]
