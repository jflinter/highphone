// Loads the recorded /capture fixtures. See test/fixtures/README.md.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Capture } from './replayCapture';

const dir = fileURLToPath(new URL('./fixtures/captures/', import.meta.url));

export const loadCapture = (id: number): Capture =>
  JSON.parse(fs.readFileSync(`${dir}${String(id).padStart(3, '0')}.json`, 'utf8'));

export const allCaptureIds = (): number[] =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => Number(f.replace('.json', '')))
    .sort((a, b) => a - b);
