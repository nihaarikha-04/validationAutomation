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
  //
  // Note: the `permissions` key being empty no longer means the extension is unprivileged.
  // Phase 2's content-script `matches` grant host access in their own right — see D5.
  it('requests no permissions or host permissions', () => {
    expect(manifest['permissions']).toBeUndefined();
    expect(manifest['host_permissions']).toBeUndefined();
  });

  it('registers both content scripts at document_start, in the worlds they need', () => {
    const scripts = manifest['content_scripts'];
    expect(Array.isArray(scripts)).toBe(true);

    const entries = (scripts ?? []) as ReadonlyArray<Record<string, unknown>>;
    expect(entries).toHaveLength(2);

    const worlds = entries.map((entry) => entry['world']);
    expect(worlds).toEqual(['MAIN', 'ISOLATED']);

    for (const entry of entries) {
      // The interceptor must beat the Smartech snippet; the bridge must be listening
      // before the interceptor posts anything.
      expect(entry['run_at']).toBe('document_start');
      expect(entry['matches']).toEqual(['<all_urls>']);
    }
  });

  it('points every content script at a file the build emits', () => {
    const entries = (manifest['content_scripts'] ?? []) as ReadonlyArray<{ js?: string[] }>;
    const sources: Readonly<Record<string, string>> = {
      'content/debug-capture.js': 'src/content/debug-capture.ts',
      'content/bridge.js': 'src/content/bridge.ts',
    };

    for (const entry of entries) {
      for (const file of entry.js ?? []) {
        const source = sources[file];
        expect(source, `no source mapped for ${file}`).toBeDefined();
        expect(existsSync(resolve(projectRoot, source ?? ''))).toBe(true);
      }
    }
  });
});
