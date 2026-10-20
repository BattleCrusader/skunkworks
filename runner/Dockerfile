# syntax=docker/dockerfile:1
#
# The plugin runner — the fourth service of §12.1 (C-8, D26).
#
# It exists because Node's permission model does **not** cover the network: measured twice,
# `fetch('http://127.0.0.1:…')` returned 200 and `net.connect` delivered a body with
# `--permission` on. `ENETUNREACH` only appears with `--network none`, which is a property of
# the container, not of the process. So the containment is **two layers that must both be
# present**: the netns (compose's `network_mode: none`) and the absent addon
# (`--allow-addons` off) — with addons on, `new Database()` can `ATTACH` a sibling tenant even
# though `fs.readFileSync` of the same path is denied (§8.4).
#
# No npm install: the runner and the child harness are `node:` built-ins only. A runner image
# with a package tree is a runner image whose supply chain is a second product to audit, and
# §8.4's cost line (47.4–48.0 MB idle) is a Node baseline, not a framework's.
FROM node:22-alpine

# The image's own build identity, so `/srv/runner` can report what it is (§12.6).
ARG RUNNER_VERSION=0.0.0-s4c

# `nobody` (65534) already exists in the base image; the process never needs to write
# outside `/srv/run` (the socket), `/srv/scratch` (per-package temp) and `/tmp`.
WORKDIR /srv/runner

COPY child.mjs server.mjs package.json ./

# Read-only root filesystem (set in compose as well): the only writable paths are the two
# mounts and the tmpfs. The chmod is for the `ro` case: nothing in here is edited at runtime.
RUN chmod 0444 /srv/runner/*.mjs && chmod 0444 /srv/runner/package.json

ENV NODE_ENV=production \
    SKW_RUNNER_SOCKET=/srv/run/plugin.sock \
    SKW_PLUGINS_DIR=/srv/plugins \
    SKW_SCRATCH_DIR=/srv/scratch \
    SKW_RUNNER_VERSION=${RUNNER_VERSION}

USER 65534:65534

# No shell: the entrypoint is node, and a shell in a container that runs third-party code is
# one more thing that can be reached.
ENTRYPOINT ["node", "/srv/runner/server.mjs"]
