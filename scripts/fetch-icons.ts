// fetch-icons.ts
// Usage:
// bun run fetch-icons.ts --dir=./icons --size=64

import sharp from "sharp";
import { mkdir } from "fs/promises";
import { join } from "path";

type IconMap = Record<string, string>;

const ICONS: IconMap = {
  immich: "https://raw.githubusercontent.com/immich-app/immich/main/design/immich-logo.svg",
  photoprism: "https://raw.githubusercontent.com/photoprism/photoprism/develop/assets/static/logo.svg",
  librephotos: "https://raw.githubusercontent.com/LibrePhotos/librephotos/master/frontend/src/assets/logo.svg",
  piwigo: "https://piwigo.org/img/piwigo.svg",
  lychee: "https://raw.githubusercontent.com/LycheeOrg/Lychee/master/public/img/Lychee.svg",

  emby: "https://avatars.githubusercontent.com/u/3607473?s=200&v=4",
  jellyfin: "https://raw.githubusercontent.com/jellyfin/jellyfin-ux/master/branding/SVG/icon.svg",
  plex: "https://www.plex.tv/wp-content/themes/plex/assets/img/plex-logo.svg",
  kodi: "https://kodi.tv/sites/default/files/kodi-logo.svg",

  nextcloud: "https://nextcloud.com/wp-content/themes/next/assets/img/common/logo.svg",
  owncloud: "https://owncloud.com/wp-content/themes/owncloudorgnew/assets/img/owncloud-logo.svg",
  seafile: "https://www.seafile.com/images/seafile-logo.svg",
  filebrowser: "https://raw.githubusercontent.com/filebrowser/filebrowser/master/frontend/public/img/icons/icon.svg",

  dozzle: "https://raw.githubusercontent.com/amir20/dozzle/master/.github/logo.svg",
  portainer: "https://www.portainer.io/hubfs/portainer-logo.svg",
  traefik: "https://doc.traefik.io/traefik/assets/img/traefik.logo.svg",
};

function getArg(name: string, defaultValue?: string) {
  const arg = Bun.argv.find(a => a.startsWith(name + "="));
  return arg ? arg.split("=")[1] : defaultValue;
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { "User-Agent": "bun-icon-fetcher" }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const size = Number(getArg("--size", "64"));
  if (size < 50 || size > 100) {
    throw new Error("Size must be between 50 and 100.");
  }

  const outputDir = getArg("--dir", "./data-seed/uploads/launchpad-icons")!;
  await mkdir(outputDir, { recursive: true });

  console.log(`Saving icons to ${outputDir} (${size}x${size})`);

  for (const [name, url] of Object.entries(ICONS)) {
    try {
      console.log(`Downloading ${name}...`);

      const input = await fetchBuffer(url);

      const png = await sharp(input, { density: 512 })
        .resize(size, size, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .png()
        .toBuffer();

      const filePath = join(outputDir, `${name}.png`);
      await Bun.write(filePath, png);

      console.log(`✓ ${name}.png`);
    } catch (err: any) {
      console.log(`✗ Failed ${name}: ${err.message}`);
    }
  }

  console.log("Done.");
}

main();