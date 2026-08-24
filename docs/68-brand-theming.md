# 68 · White-label that reaches the product

## 1. It was wired to three elements

White-label has existed since Sprint 14. A tenant sets five colours, the shell
publishes them as `--brand-*` custom properties, an admin screen previews them,
and a browser test covers it.

Three things in the whole product consumed those tokens: the workspace name in
the header, the active navigation item, and the branding screen's own swatch.
Everywhere else — **217 usages across 67 files** — was a hardcoded Tailwind
`teal`.

So a tenant could set their colours, save, and watch the header change while
every button, tab, chip and progress bar stayed AVIORA's teal. The feature was
present, documented, tested, and did almost nothing.

## 2. The brand is a colour, not a variable each component must remember

Asking sixty-seven files to remember `var(--brand-primary)` would work once and
decay immediately — the next component would use `teal-700` like its neighbours.

Instead the brand becomes a Tailwind colour. `bg-brand-700` resolves through
`--brand-primary` when a tenant has set one, and to the teal this product has
always used when they have not, so **nothing changes for a tenant who never
opens the branding screen**.

The shades are mixed from the one colour the tenant actually chose. Asking an
administrator for nine of them would be asking them to be a designer; asking for
one and deriving the rest with `color-mix` in oklab keeps the steps
perceptually even rather than muddy.

## 3. `@theme inline`, and why the first attempt silently did nothing

The first version used a plain `@theme` block. Every utility resolved to the
fallback teal, and the mechanism looked wired while doing nothing at all.

The reason is a CSS rule that is easy to reason past: **a `var()` inside a
custom-property declaration is substituted at the element that declares it.**
Tailwind emitted `--color-brand-700: var(--brand-primary, #0f766e)` on `:root`,
and `--brand-primary` does not exist on `:root` — the shell sets it on a
descendant. The fallback won, and the computed teal inherited down looking
entirely deliberate.

`@theme inline` puts the expression into each utility instead of into a `:root`
variable, so it resolves on the element that uses it, where the tenant's colour
has been inherited.

It was caught by reading a computed style, not by looking: `#0f766e` and a
tenant colour both look like "a teal-ish button" in a screenshot.

## 4. Proved by changing the answer

The check sets the tenant's primary to an unmistakable terracotta, reads
`getComputedStyle` on a tab deep in the product, sets it back, and asserts the
two differ **and** that neither is the fallback.

Asserting one colour would have passed against a hardcoded value. The assertion
that matters is that the product's colour _follows_ the tenant's — which only a
change can demonstrate.

## 5. What is still not themeable

`onPrimary`, `surface` and `text` are published and largely unconsumed — page
grounds are still `bg-slate-50` and body text `text-slate-800`. Primary and
accent carry the visible identity, so those went first; the neutrals are a
second pass, and worth doing before anybody claims the product is fully
white-label.

Fonts already work: the allow-list carries Thai faces (Sarabun, Prompt, Kanit,
Noto Sans Thai) and the shell applies the stack.
