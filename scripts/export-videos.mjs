// Downloads every journey video from the old Supabase Storage `journeys`
// bucket into ./journeys-export/, ready to bulk-upload to R2.
//
// Storage listing is not public, so this needs the service-role key (Supabase
// dashboard -> Project Settings -> API -> service_role secret). Do NOT commit
// it.
//
// Usage:
//   SUPABASE_SERVICE_KEY=xxxxx node scripts/export-videos.mjs
//
// Then bulk-upload to R2 (fish):
//   for f in journeys-export/*.mp4
//     wrangler r2 object put highphone-journeys/(basename $f) --file $f --remote
//   end

import { mkdir, writeFile } from 'node:fs/promises';

const SUPABASE_URL = 'https://hdfaiysbnbanqshkbamz.supabase.co';
const BUCKET = 'journeys';
const KEY = process.env.SUPABASE_SERVICE_KEY;
const OUT_DIR = 'journeys-export';
const PAGE = 100;

if (!KEY) {
  console.error('Set SUPABASE_SERVICE_KEY (service_role secret) in the env.');
  process.exit(1);
}

const auth = { apikey: KEY, authorization: `Bearer ${KEY}` };

const listPage = async (offset) => {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      prefix: '',
      limit: PAGE,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    }),
  });
  if (!res.ok) throw new Error(`list ${res.status}: ${await res.text()}`);
  return res.json();
};

const download = async (name) => {
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURIComponent(name)}`,
    { headers: auth }
  );
  if (!res.ok) throw new Error(`get ${name} ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

const main = async () => {
  await mkdir(OUT_DIR, { recursive: true });
  let count = 0;
  for (let offset = 0; ; offset += PAGE) {
    const items = await listPage(offset);
    for (const item of items) {
      if (!item.name || item.id === null) continue; // skip folder placeholders
      const bytes = await download(item.name);
      await writeFile(`${OUT_DIR}/${item.name}`, bytes);
      count++;
      process.stderr.write(`downloaded ${count}: ${item.name}\n`);
    }
    if (items.length < PAGE) break;
  }
  process.stderr.write(`\nDone. ${count} videos in ${OUT_DIR}/\n`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
