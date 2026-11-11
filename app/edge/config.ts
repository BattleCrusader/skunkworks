/**
 * Where the edge reads its config, and who writes it.
 *
 * The path is a **three-way contract** and it has already been broken once:
 *
 *   - `docker-compose.yml` mounts `./data/nginx/10-app.conf` → `/etc/nginx/conf.d/10-app.conf`;
 *   - `install.sh` generates that same file from the seeded `control.db`;
 *   - the CMS writes it again whenever a site is imported (`/fleet/import`, `skwctl site import`).
 *
 * When the writers disagreed with the mount (`<dataDir>/nginx/conf.d/…`, and the checkout's tracked
 * fixture), every report said "edge config written" while nginx kept serving the config it booted
 * with — a site could be imported, its rows written, its pages reachable in the admin, and the host
 * would still 404 in the browser. One function, one path, and `test/edge-config.test.ts` reads all
 * three places to prove they agree.
 */
import { join } from 'node:path';

/** The file nginx mounts, inside the box's data directory. */
export function edgeConfigPath(dataDir: string): string {
  return join(dataDir, 'nginx', '10-app.conf');
}
