import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(import.meta.dirname, '..');
const manifest: Record<string, unknown> = JSON.parse(
  readFileSync(resolve(projectRoot, 'public/manifest.json'), 'utf8'),
);

describe('manifest.json', () => {
  it('declares Manifest V3', () => {
    expect(manifest['manifest_version']).toBe(3);
  });

  it('registers the DevTools page', () => {
    expect(manifest['devtools_page']).toBe('devtools/devtools.html');
  });

  it('points devtools_page at a file that exists in src/', () => {
    expect(existsSync(resolve(projectRoot, 'src', 'devtools/devtools.html'))).toBe(true);
  });

  // Guards the Phase 0 requirement that permissions stay minimal. Later phases add
  // entries here deliberately; this test failing means something crept in.
  it('requests no permissions or host permissions', () => {
    expect(manifest['permissions']).toBeUndefined();
    expect(manifest['host_permissions']).toBeUndefined();
  });
});
