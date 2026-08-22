/**
 * The output filter's own tests (docs/50).
 *
 * Both directions matter equally, and the false-POSITIVE cases are the ones
 * that decide whether this survives contact with real use: a filter that blocks
 * "magnesium does not cure insomnia" punishes the model for giving the correct
 * answer to a dangerous question, and the first person to hit that will ask for
 * the filter to be turned off.
 */
import { describe, expect, it } from 'vitest';
import { checkAnswer } from './output-safety';

describe('It catches what the prompt is supposed to prevent', () => {
  it('catches a diagnosis', () => {
    expect(checkAnswer('Based on that, you likely have sleep apnea.').hits).toContain('diagnosis');
    expect(checkAnswer('That sounds like you have a thyroid problem.').hits).toContain('diagnosis');
  });

  it('catches a treatment claim', () => {
    expect(checkAnswer('Magnesium cures insomnia.').hits).toContain('treatment_claim');
    expect(checkAnswer('This blend is proven to treat anxiety.').hits).toContain('treatment_claim');
  });

  it('catches medication instructions', () => {
    expect(
      checkAnswer('You should stop taking your medication and try this instead.').hits,
    ).toContain('medication_instruction');
    expect(checkAnswer('Double your dose for a week.').hits).toContain('medication_instruction');
  });

  it('catches all three in Thai', () => {
    expect(checkAnswer('คุณน่าจะเป็นโรคเบาหวาน').hits).toContain('diagnosis');
    expect(checkAnswer('อาหารเสริมนี้รักษาโรคนอนไม่หลับได้').hits).toContain('treatment_claim');
    expect(checkAnswer('ควรหยุดยาที่กินอยู่').hits).toContain('medication_instruction');
  });
});

describe('It does not punish the model for behaving', () => {
  it('allows a correct refusal of a dangerous claim', () => {
    // The single most important false-positive case: this IS the answer the
    // prompt asks for.
    expect(checkAnswer('Magnesium does not cure insomnia.').safe).toBe(true);
    expect(checkAnswer('No supplement treats depression.').safe).toBe(true);
    expect(checkAnswer('ไม่มีอาหารเสริมใดรักษาโรคซึมเศร้าได้').safe).toBe(true);
  });

  it('allows the label disclaimer every product carries', () => {
    expect(checkAnswer('Not intended to diagnose, treat, cure, or prevent any disease.').safe).toBe(
      true,
    );
  });

  it('allows educational, hedged wellness language', () => {
    expect(checkAnswer('Magnesium may support sleep quality for some people.').safe).toBe(true);
    expect(checkAnswer('Regular sleep timing is associated with feeling more rested.').safe).toBe(
      true,
    );
    expect(checkAnswer('แมกนีเซียมอาจช่วยเรื่องการนอนหลับ').safe).toBe(true);
  });

  it('allows the safety note the assistant is told to add', () => {
    expect(
      checkAnswer(
        'This is general wellness information, not medical advice. Speak with a ' +
          'qualified healthcare professional about your situation.',
      ).safe,
    ).toBe(true);
  });
});

describe('Negation binds to its own sentence', () => {
  it('does not let a safe opening excuse an unsafe follow-up', () => {
    // Checking the whole answer at once would pass this on its first half.
    const verdict = checkAnswer(
      'Magnesium does not cure insomnia. Take 400mg nightly to cure your insomnia.',
    );
    expect(verdict.safe, 'a disclaimer in sentence one hid a claim in sentence two').toBe(false);
    expect(verdict.hits).toContain('treatment_claim');
  });
});
