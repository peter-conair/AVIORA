# 48 — The Door Everyone Can Knock On (Sprint 29)

> Found by asking which routes the rate limiter actually covers. The answer was
> `PublicApiController` and nothing else — so the **public API** is limited to
> 120 requests a minute, and `POST /auth/login` is limited to nothing at all.

## 1. What it does today

Sixty wrong passwords against a real account, from one connection:

```
60 wrong-password attempts in 2s
  60 × 401
```

Roughly thirty guesses a second, none refused, no delay, no lockout, no record.
A list of ten thousand common passwords takes about five minutes.

Two things are already right and stay that way:

- **No account enumeration.** An unknown address and a wrong password return the
  same body — `Invalid email or password` — in comparable time. Nothing here
  may change that.
- **Refresh-token reuse kills the family.** Stolen tokens are already handled;
  this is about guessing the password in the first place.

## 2. Two keys, because either alone is bypassable

| Key             | Stops                                                      |
| --------------- | ---------------------------------------------------------- |
| per **IP**      | one source working through a password list                 |
| per **account** | credential stuffing against one victim from a thousand IPs |

Limiting only by IP leaves a botnet unbothered. Limiting only by account lets
one source spray a thousand accounts at one attempt each. Both, always.

## 3. The three rules that keep this from becoming the attack

**Only failures count, and a success clears the counter.** Counting every
request would throttle a legitimate person on a bad connection retrying a form
they typed correctly.

**There is no permanent lockout — ever.** A lock that persists until an
administrator lifts it hands anyone who knows your email address a denial of
service against you. The window expires on its own, always.

**The per-account key is the submitted address, hashed, whether or not the
account exists.** If only real accounts throttled, "this address throttles"
would answer the enumeration question §1 says stays answered. So the counter
increments for `nobody@example.com` exactly as it does for a real member.

## 4. When Redis is unreachable

The shared counter lives in Redis (docs/38 §2). If Redis is down, this falls
back to the **in-memory** limiter rather than to nothing: a single instance
still bounds attempts, which is what the platform had before this sprint.

It does **not** fail closed. A cache outage that locks every user out of the
product is a worse day than a cache outage that degrades brute-force protection
to per-process — and an attacker cannot cause the Redis outage that would help
them without already being somewhere much more interesting.

## 5. Limits

Deliberately generous for a person and useless for a script:

| Route                         | Per IP     | Per account |
| ----------------------------- | ---------- | ----------- |
| `POST /auth/login`            | 10 / 5 min | 5 / 5 min   |
| `POST /auth/register`         | 5 / hour   | —           |
| `POST /invitations/:t/accept` | 20 / hour  | —           |

A person who has genuinely forgotten their password gets five tries and waits
five minutes. A script gets five tries and waits five minutes.

Refused attempts answer **429 with `Retry-After`**, the same shape the public
API already uses — a caller should never have to guess whether they are blocked
or broken.

## 6. Somebody is told

A spike in refusals is the shape of an attack in progress, so it becomes an
alert check beside the others (docs/42 §2): `auth.failures` fires when refused
authentication attempts cross a threshold in a window. The platform already had
the audit rows and the observability surface; what it lacked was anything
watching them.

## 7. What this does not do

- **No CAPTCHA.** It belongs at a proxy or a WAF, and adding one here would put
  a third-party script on the sign-in page of a health product.
- **No IP banning or reputation.** Blocking addresses needs an appeal path and
  an operator to run it; a self-healing window needs neither.
- **No password-strength change.** Argon2id and a 10-character minimum are
  already in place; this is about the rate of guessing, not the guess.
