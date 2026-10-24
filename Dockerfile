# Official Playwright container with Node 20 & all browser system dependencies
FROM mcr.microsoft.com/playwright:v1.49.0-noble

WORKDIR /app

# Install Xvfb and xauth for virtual display
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    xauth \
    tar \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies
RUN npm install
RUN npx playwright install chromium

# Copy application source code
COPY . .
RUN chmod +x entrypoint.sh

# Environment variables
ENV PORT=3000
ENV HEADLESS=false
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 3000

# Start via entrypoint script
CMD ["./entrypoint.sh"]
