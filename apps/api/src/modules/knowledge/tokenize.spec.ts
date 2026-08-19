import { describe, expect, it } from 'vitest';
import { tokenize } from './knowledge.service';

describe('tokenize', () => {
  it('keeps meaningful words and drops stop words', () => {
    expect(tokenize('How can I sleep better?')).toEqual(['sleep']);
  });

  it('drops duplicates and very short latin words', () => {
    expect(tokenize('magnesium MAGNESIUM in my tea')).toEqual(['magnesium', 'tea']);
  });

  it('keeps the whole Thai run and adds n-grams from it', () => {
    const terms = tokenize('การนอน');
    expect(terms[0]).toBe('การนอน');
    expect(terms.every((t) => 'การนอน'.includes(t))).toBe(true);
  });

  it('cuts a long Thai run into overlapping n-grams', () => {
    // Thai has no word spacing, so a full sentence must still produce terms
    // that appear inside the content.
    const terms = tokenize('ฉันควรทำอย่างไรให้การนอนดีขึ้น');
    expect(terms.length).toBeGreaterThan(1);
    expect(terms.some((t) => 'สุขอนามัยการนอน'.includes(t))).toBe(true);
  });

  it('falls back to the raw query when everything was a stop word', () => {
    expect(tokenize('how do I')).toEqual(['how do i']);
  });
});
