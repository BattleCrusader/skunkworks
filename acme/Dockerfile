# The acme service (§12.1, §12.5; S4e).
#
# Build from the repository root so the tool keeps one home:
#     docker build -f acme/Dockerfile -t skw-acme:s4e .
#
# One file, `node:` built-ins only — the same rule the runner image follows. `node:sqlite`
# reads `control.db`; the CSR is DER built by the tool itself because no openssl exists in
# this base image; the reload goes over the Docker socket because there is no docker CLI
# either. A service image whose supply chain is a second product to audit is not worth 90 MB.
FROM node:22-alpine
# Not `/srv/acme`: that path is the http-01 **webroot** the service mounts read-write, and an
# image file under it is hidden by the mount (measured: MODULE_NOT_FOUND for its own entry).
WORKDIR /srv/acme-tool
COPY tools/acme.mjs /srv/acme-tool/acme.mjs
RUN chmod 0444 /srv/acme-tool/acme.mjs
ENV NODE_ENV=production \
    SKW_ACME_DATA=/srv/data \
    SKW_ACME_CERTS=/srv/certs \
    SKW_ACME_WEBROOT=/srv/acme
# `node:22` still gates `node:sqlite` behind the flag; the tool needs it for control.db.
ENTRYPOINT ["node", "--experimental-sqlite", "/srv/acme-tool/acme.mjs"]
