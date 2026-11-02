# ISLA draft-only artifact; no build or upstream startup on the target. AGPL-3.0.
FROM node@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
WORKDIR /app
COPY --chown=0:0 . /app/
USER 1000:1000
HEALTHCHECK --interval=30s --timeout=8s --start-period=10s --retries=3 CMD ["node", "healthcheck.mjs"]
CMD ["node", "--max-old-space-size=192", "NewsletterServer.js", "/run/newsletter/config.json"]
