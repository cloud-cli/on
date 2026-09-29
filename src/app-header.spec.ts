import { describe, expect, it } from 'vitest';
import headerTemplate from './app-header.html?raw';

describe('app header', () => {
  it('unauthenticated header shows user-round icon linking to /settings', () => {
    expect(headerTemplate).toMatch(
      /<template if="!authenticated">[\s\S]*?href="\/settings" aria-label="Settings" title="Settings">[\s\S]*?icon="user-round"[\s\S]*?<\/template>/,
    );
  });

  it('authenticated header settings control links to /settings', () => {
    expect(headerTemplate).toMatch(
      /<template if="authenticated">[\s\S]*?href="\/settings" aria-label="Settings" title="Settings">[\s\S]*?icon="circle-user-round"[\s\S]*?<\/template>/,
    );
  });
});
