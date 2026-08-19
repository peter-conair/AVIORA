import { describe, expect, it } from 'vitest';
import { tokenize } from './knowledge.service';

describe('tokenize', () => {
  it('keeps meaningful words and drops stop words', () => {
    expect(tokenize('How can I sleep better?')).toEqual(['sleep']);
  });

  it('drops duplicates and very short latin words', () => {
    expect(tokenize('magnesium MAGNESIUM in my tea')).toEqual(['magnesium', 'tea']);
  });

  it('keeps Thai runs, which have no word spacing', () => {
    expect(tokenize('การนอนหลับ')).toEqual(['การนอนหลับ']);
  });

  it('falls back to the raw query when everything was a stop word', () => {
    expect(tokenize('how do I')).toEqual(['how do i']);
  });
});
