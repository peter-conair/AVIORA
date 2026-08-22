/**
 * The post-generation check docs/12 §8 has promised since it was written
 * (docs/50).
 *
 * Until now the safety rules lived only in the system prompt. A prompt is an
 * instruction to a model, not a control: it holds for a well-behaved model on
 * an ordinary question, and it is exactly what a jailbreak, a translation slip
 * or an unlucky sample defeats. In a product about people's health, "we asked
 * the model not to" should not be the only thing standing between a member and
 * a diagnosis.
 *
 * What this is: a **backstop for a model slip**, in two languages, that fails
 * loudly rather than rewriting quietly.
 *
 * What it is NOT, stated so nobody builds on a wrong assumption:
 *   · not a defence against a determined jailbreak — anything that can rephrase
 *     can evade a pattern
 *   · not a medical classifier
 *   · not a substitute for the prompt rules, which still do the real work
 */

export type SafetyHit = 'diagnosis' | 'treatment_claim' | 'medication_instruction';

export interface SafetyVerdict {
  safe: boolean;
  hits: SafetyHit[];
}

/**
 * Negation and hedging, checked FIRST.
 *
 * "Magnesium does not cure insomnia" and "no supplement treats depression" are
 * the correct answers to dangerous questions, and a filter that blocked them
 * would punish the model for behaving. Educational phrasing — "may support",
 * "is associated with" — is likewise the register this product wants.
 */
const NEGATED = [
  /\b(?:does not|doesn't|do not|don't|cannot|can't|won't|will not|never)\s+(?:\w+\s+){0,3}(?:cure|cures|treat|treats|prevent|prevents|diagnose|diagnoses)\b/i,
  /\bno\s+(?:\w+\s+){0,3}(?:supplement|product|food|ingredient)\s+(?:\w+\s+){0,2}(?:cures?|treats?|prevents?)\b/i,
  /\bnot\s+(?:intended|meant)\s+to\s+(?:diagnose|treat|cure|prevent)\b/i,
  // NO \b on the Thai patterns. A word boundary is defined against ASCII word
  // characters, so `\bไม่` never matches — Thai has no ASCII letters and no
  // spaces between words. The first version of this file carried \b here and
  // silently matched nothing, which is the worst possible state for a safety
  // filter: present, green, and inert.
  /ไม่(?:ได้)?\s*(?:รักษา|ป้องกัน|วินิจฉัย)/,
  /ไม่มี\S*\s*\S*\s*(?:รักษา|ป้องกัน)/,
  /ไม่ใช่\s*(?:คำแนะนำทางการแพทย์|การวินิจฉัย)/,
];

/** Telling somebody what they have. */
const DIAGNOSIS = [
  /\byou\s+(?:probably|likely|may|might|could)?\s*have\s+(?:\w+\s+){0,2}(?:diabetes|depression|anxiety disorder|apnea|apnoea|hypertension|cancer|deficiency syndrome|disorder|disease|syndrome|infection)\b/i,
  /\b(?:this|that|it)\s+(?:sounds|looks)\s+like\s+(?:you\s+have|a case of)\b/i,
  /\byou\s+are\s+(?:suffering from|diagnosed with)\b/i,
  /คุณ(?:น่าจะ|อาจจะ|คง)?\s*เป็น\s*(?:โรค|ภาวะ)/,
  /อาการของคุณ\s*(?:บ่งชี้|แสดงว่า)/,
];

/** Claiming something treats, cures or prevents disease. */
const TREATMENT_CLAIM = [
  /\b(?:cures?|treats?|prevents?|reverses?|heals?)\s+(?:\w+\s+){0,3}(?:diabetes|depression|anxiety|insomnia|cancer|hypertension|disease|disorder|syndrome|infection)\b/i,
  /\bproven\s+to\s+(?:cure|treat|prevent|reverse)\b/i,
  /(?:รักษา|ป้องกัน|หาย)\s*(?:โรค|อาการ)/,
];

/** Telling somebody to change medication. */
const MEDICATION = [
  /\b(?:stop|start|increase|decrease|double|halve|skip)\s+(?:taking\s+)?(?:your\s+)?(?:medication|medicine|prescription|dose|dosage|pills?|tablets?|insulin|antidepressants?)\b/i,
  /\byou\s+(?:should|can)\s+(?:stop|come off|reduce)\s+(?:your\s+)?(?:medication|medicine|prescription)\b/i,
  /(?:หยุด|เพิ่ม|ลด|เลิก)\s*(?:ยา|การใช้ยา)/,
];

const RULES: Array<{ hit: SafetyHit; patterns: RegExp[] }> = [
  { hit: 'diagnosis', patterns: DIAGNOSIS },
  { hit: 'treatment_claim', patterns: TREATMENT_CLAIM },
  { hit: 'medication_instruction', patterns: MEDICATION },
];

/**
 * Sentence-level, because negation binds to a sentence. Checking the whole
 * answer at once would let "Magnesium does not cure insomnia. Take 400mg to
 * cure your insomnia." pass on the strength of its first half.
 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function checkAnswer(text: string): SafetyVerdict {
  const hits = new Set<SafetyHit>();
  for (const sentence of sentences(text)) {
    if (NEGATED.some((re) => re.test(sentence))) continue;
    for (const { hit, patterns } of RULES) {
      if (patterns.some((re) => re.test(sentence))) hits.add(hit);
    }
  }
  return { safe: hits.size === 0, hits: [...hits] };
}

/**
 * What a member sees instead. It refuses rather than rewriting: an answer
 * silently edited to look safe is an answer nobody can audit, and the member
 * cannot tell what was removed.
 */
export function safeReplacement(locale: string): string {
  return locale === 'th'
    ? 'ขออภัย ระบบไม่สามารถแสดงคำตอบนี้ได้ เพราะอาจมีเนื้อหาที่เข้าข่ายการวินิจฉัยโรค ' +
        'การอ้างสรรพคุณรักษาโรค หรือคำแนะนำเรื่องยา ซึ่งอยู่นอกขอบเขตของผู้ช่วยนี้ ' +
        'กรุณาปรึกษาบุคลากรทางการแพทย์สำหรับเรื่องเฉพาะบุคคล'
    : 'This answer was withheld because it may contain a diagnosis, a claim that ' +
        'something treats or prevents disease, or medication advice — none of which ' +
        'this assistant is able to give. Please speak with a qualified healthcare ' +
        'professional about your situation.';
}
