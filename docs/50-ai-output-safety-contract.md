# 50 — The Output Check That Was Only a Sentence (Sprint 31)

> `docs/12 §8` lists seven health-safety rules "enforced in layer [2] of the
> system prompt **plus** output-side checks", including item 6: _"A lightweight
> post-generation check … scans responses for diagnosis/claim language"_ and
> item 7: _"Safety interventions are audit events."_
>
> Neither existed. The prompt was the whole of it.

## 1. Why a prompt is not a control

A system prompt is an instruction to a model. It holds for a well-behaved model
on an ordinary question — which is most of the time, and is exactly why nobody
noticed. It is also the first thing a jailbreak defeats, the thing a translation
slip walks past, and the thing an unlucky sample ignores.

In a product about people's health, "we asked the model not to" should not be
the only thing between a member and a sentence beginning _"you probably have"_.

So there is now a check on the way out. It is a **backstop for a slip**, and the
contract is honest about what it is not:

- **Not** a defence against a determined jailbreak. Anything that can rephrase
  can evade a pattern.
- **Not** a medical classifier.
- **Not** a replacement for the prompt rules, which still do the real work.

A backstop that is described as a guarantee is worse than none, because somebody
will relax the thing in front of it.

## 2. What it catches

| Hit                      | The sentence it exists for                 |
| ------------------------ | ------------------------------------------ |
| `diagnosis`              | "you likely have sleep apnea"              |
| `treatment_claim`        | "magnesium cures insomnia"                 |
| `medication_instruction` | "stop taking your medication and try this" |

In **English and Thai**, because the assistant answers in the member's language
and a filter that only reads English is a filter that is off for half the users.

## 3. The three decisions that make it usable

**It refuses; it does not rewrite.** A blocked answer is replaced wholesale with
a plain refusal in the member's language. Editing an answer to look safe leaves
something nobody can audit and the member cannot tell what was removed.

**Negation is checked first, and per sentence.** "Magnesium does not cure
insomnia" is the _correct_ answer to a dangerous question, and a filter that
blocked it would punish the model for behaving — the first person to hit that
would ask for the filter to be turned off, and they would be right. Sentence
scope matters too: checked whole, "Magnesium does not cure insomnia. Take 400mg
to cure your insomnia." would pass on the strength of its first half. There is
a test for exactly that string.

**Every block is an audit row** (`ai.safety.blocked`) carrying which rules hit
and which agent produced it — item 7 of §8, and the only way to answer "how
often does this happen, and is it getting worse".

## 4. What it cost to get right

The Thai patterns silently matched nothing on the first attempt, because they
carried `\b` word boundaries. `\b` is defined against ASCII word characters;
Thai has none, and no spaces between words either. The filter was present,
green, and inert for half the product's users — the exact failure mode this
codebase has now hit six times, and the reason the tests assert Thai cases
separately rather than trusting the English ones to generalise.

## 5. Where it does not run

Only on generated answers. Knowledge articles, product copy and tenant-authored
text are reviewed by people and carry their own safety notes; passing them
through a pattern filter would flag the label disclaimer every supplement
carries — _"not intended to diagnose, treat, cure, or prevent any disease"_ —
which is a sentence this platform wants to keep saying.
