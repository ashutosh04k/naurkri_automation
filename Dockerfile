# Official Playwright container with Node 20 & all browser system dependencies
FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

# Install Xvfb for virtual display (enables headed Chrome without an attached monitor)
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    tar \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies
RUN npm install

# Copy application source code
COPY . .

# Environment variables
ENV PORT=3000
ENV HEADLESS=false
ENV PLAYWRIGHT_BROWSERS_PATH=0

EXPOSE 3000

# Start with virtual display to bypass Akamai headless bot-checks
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1280x850x24", "node", "cron-worker.js"]
